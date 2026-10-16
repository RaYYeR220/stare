import { randomBytes } from 'node:crypto';
import type { NamedQuery } from './db.ts';
import { decide, type EngineCtx } from './engine/decide.ts';
import type { PolicyId } from './engine/types.ts';
import { LEDGER_HEAD, ledgerParams, ledgerWrite } from './ledger.ts';
import { proposeRules } from './rules.ts';

const q = (name: string, mode: 'ro' | 'rw', doc: string, cypher: string): NamedQuery => ({ name, mode, doc, cypher: cypher.trim() });

export const APPROVE_QUERIES = {
  load: q(
    'approve.loadEscalation',
    'ro',
    'An escalation with its case, account and the person it was routed to.',
    `
MATCH (e:Escalation {id:$id})-[:FOR]->(c:Case)-[:FOR]->(a:Account)
OPTIONAL MATCH (e)-[:ROUTED_TO]->(p:Person)
RETURN e.status AS status, c.id AS caseId, c.policyId AS policyId, c.value AS value, c.days AS days, c.reason AS reason,
       c.text AS text, a.id AS accountId, a.name AS account, p.id AS routedTo, p.name AS routedName`,
  ),
  authority: q(
    'approve.authorityNow',
    'ro',
    'What a person may approve right now under a policy, and whether they own the account (separation of duties).',
    `
MATCH (p:Person {id:$personId})
OPTIONAL MATCH (p)-[h:HOLDS]->(:Role)-[g:MAY_APPROVE]->(:Policy {id:$policyId})
WHERE h.validFrom <= $now AND $now < h.validTo AND g.validFrom <= $now AND $now < g.validTo
WITH p, max(g.cap) AS cap
OPTIONAL MATCH (p)-[ow:OWNS]->(:Account {id:$accountId})
WHERE ow.validFrom <= $now AND $now < ow.validTo
RETURN p.name AS name, p.leftAt > $now AS active, coalesce(cap, 0) AS cap, count(ow) > 0 AS owns`,
  ),
  commit: q(
    'approve.commitHumanDecision',
    'rw',
    "Record a person's ruling on an escalation. Their authority, tenure and independence are re-checked inside the write; if any fails, nothing is written.",
    `
${LEDGER_HEAD}
MATCH (e:Escalation {id:$escalationId}) WHERE e.status = 'open'
MATCH (e)-[:FOR]->(c:Case) WHERE c.status <> 'decided'
MATCH (pv:PolicyVersion {id:$pvId}) WHERE pv.effectiveFrom <= $now AND $now < pv.effectiveTo
MATCH (a:Account {id:$accountId}), (rs:Reason {code:$reason})
MATCH (p:Person {id:$personId}) WHERE p.leftAt > $now
OPTIONAL MATCH (p)-[h:HOLDS]->(:Role)-[g:MAY_APPROVE]->(:Policy {id:$policyId})
WHERE h.validFrom <= $now AND $now < h.validTo AND g.validFrom <= $now AND $now < g.validTo
WITH lh, e, c, pv, a, rs, p, max(g.cap) AS cap
WHERE cap >= $value
OPTIONAL MATCH (p)-[ow:OWNS]->(a) WHERE ow.validFrom <= $now AND $now < ow.validTo
WITH lh, e, c, pv, a, rs, p, count(ow) AS owned
WHERE owned = 0
OPTIONAL MATCH (x:Decision) WHERE x.id IN $citeIds
WITH lh, e, c, pv, a, rs, p, collect(x) AS precs
CREATE (d:Decision {id:$decisionId, caseId:c.id, outcome:$outcome, value:$value, requested:$requested, basis:'human', at:$now,
                    policyId:$policyId, policyVersionId:$pvId, accountId:$accountId, facts:$facts, narrative:$narrative, note:$note})
CREATE (d)-[:DECIDES]->(c), (d)-[:APPLIED_POLICY]->(pv), (d)-[:MADE_BY]->(p), (d)-[:ABOUT]->(a), (d)-[:BECAUSE]->(rs), (e)-[:RESOLVED_BY]->(d)
SET c.status = 'decided', e.status = $status, e.resolvedAt = $now
FOREACH (x IN CASE WHEN $outcome = 'approved' THEN [d] ELSE [] END | SET x:Exception)
FOREACH (x IN precs | CREATE (x)-[:PRECEDENT_FOR {similarity: 1.0, at: $now}]->(d))
WITH lh, c, d
OPTIONAL MATCH (c)-[:FROM]->(s:Span)
WITH lh, d, collect(s) AS ss
FOREACH (x IN ss | CREATE (d)-[:GROUNDED_IN]->(x))
${ledgerWrite(['d'])}
SET d.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(d)
RETURN d.id AS id, le.seq AS seq`,
  ),
} as const;

export interface ResolveInput {
  escalationId: string;
  personId: string;
  approve: boolean;
  /** Approve a different amount than asked (e.g. a partial grant). */
  value?: number;
  note?: string;
}

export interface ResolveResult {
  ok: boolean;
  refusal: { code: string; detail: string } | null;
  decisionId: string | null;
  ledgerSeq: number | null;
  outcome: 'approved' | 'denied' | null;
  value: number | null;
  approver: { id: string; name: string; cap: number } | null;
  citations: string[];
  proposedRules: string[];
}

/**
 * A person rules on an escalation. The server reaches this through an MCP elicitation (MRTR) bound to
 * the authenticated principal, so a model can never approve on someone's behalf.
 */
export async function resolveEscalation(ctx: EngineCtx, input: ResolveInput): Promise<ResolveResult> {
  const now = ctx.clock.now();
  const res: ResolveResult = { ok: false, refusal: null, decisionId: null, ledgerSeq: null, outcome: null, value: null, approver: null, citations: [], proposedRules: [] };
  const [e] = await ctx.db.ro<{ status: string; caseId: string; policyId: PolicyId; value: number; days: number | null; reason: string; text: string; accountId: string; account: string; routedTo: string }>(
    APPROVE_QUERIES.load,
    { id: input.escalationId },
  );
  if (!e) return { ...res, refusal: { code: 'NOT_FOUND', detail: 'no such escalation' } };
  if (e.status !== 'open') return { ...res, refusal: { code: 'NOT_OPEN', detail: `escalation is ${e.status}` } };
  const value = input.approve ? (input.value ?? e.value) : 0;
  const [auth] = await ctx.db.ro<{ name: string; active: boolean; cap: number; owns: boolean }>(APPROVE_QUERIES.authority, {
    personId: input.personId, policyId: e.policyId, accountId: e.accountId, now,
  });
  if (!auth || !auth.active) return { ...res, refusal: { code: 'NOT_AUTHORIZED', detail: 'not an active member of staff' } };
  res.approver = { id: input.personId, name: auth.name, cap: auth.cap };
  if (auth.owns) return { ...res, refusal: { code: 'CONFLICT', detail: `${auth.name} owns ${e.account}; someone independent must rule` } };
  if (auth.cap <= 0 || auth.cap < value) {
    return { ...res, refusal: { code: 'NOT_AUTHORIZED', detail: `${auth.name} may approve up to ${auth.cap} under ${e.policyId}; this needs ${value}` } };
  }

  // What the approver saw: the same good-law analysis the agent ran, and the policy limits in force.
  const dry = await decide(ctx, {
    principal: { kind: 'person', id: input.personId },
    intake: { policyId: e.policyId, accountName: e.account, value: input.approve ? value : e.value, days: e.days, reason: e.reason, claims: [] },
    dryRun: true,
  });
  if (input.approve && dry.limitViolations.length) {
    const c = dry.limitViolations[0]!;
    return { ...res, refusal: { code: 'POLICY_LIMIT', detail: `${dry.policyVersionId} ${c.key}: nobody may grant this` } };
  }
  res.citations = dry.citations.filter((c) => c.standing.flag === 'green').map((c) => c.id);
  const decisionId = `dec-${randomBytes(5).toString('hex')}`;
  const outcome = input.approve ? 'approved' : 'denied';
  const narrative = `${input.approve ? 'Approved' : 'Rejected'} by ${auth.name}${input.note ? `: ${input.note}` : '.'}`;
  const payload = {
    caseId: e.caseId, outcome, value, basis: 'human', policyVersionId: dry.policyVersionId, madeBy: input.personId, at: now,
    onAuthorityOf: null, accountId: e.accountId, cites: res.citations, subjectCommitment: null, escalationId: input.escalationId,
  };
  const { rows } = await ctx.db.rw<{ id: string; seq: number }>(APPROVE_QUERIES.commit, {
    escalationId: input.escalationId, pvId: dry.policyVersionId, accountId: e.accountId, reason: e.reason, personId: input.personId,
    policyId: e.policyId, value, requested: e.value, citeIds: res.citations, decisionId, outcome, now, narrative, note: input.note ?? '',
    status: input.approve ? 'approved' : 'rejected',
    facts: JSON.stringify({ policyId: e.policyId, value, requested: e.value, days: e.days, reason: e.reason, tier: dry.account?.tier, accountStatus: dry.account?.status }),
    ...ledgerParams('decision', decisionId, now, payload),
  });
  if (!rows.length) return { ...res, refusal: { code: 'CHANGED_UNDER_US', detail: 'authority, tenure or the escalation changed while ruling' } };
  res.ok = true;
  res.decisionId = rows[0]!.id;
  res.ledgerSeq = rows[0]!.seq;
  res.outcome = outcome;
  res.value = value;
  if (input.approve) res.proposedRules = await proposeRules(ctx);
  return res;
}
