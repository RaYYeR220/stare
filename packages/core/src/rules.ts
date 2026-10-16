import { randomBytes } from 'node:crypto';
import type { Db, NamedQuery } from './db.ts';
import type { EngineCtx } from './engine/decide.ts';
import { fmtValue } from './engine/template.ts';
import type { PolicyId } from './engine/types.ts';
import { LEDGER_HEAD, ledgerParams, ledgerWrite } from './ledger.ts';

const q = (name: string, mode: 'ro' | 'rw', doc: string, cypher: string): NamedQuery => ({
  name,
  mode,
  doc,
  cypher: cypher.trim(),
});
const TIERS = ['standard', 'growth', 'enterprise'] as const;
export const MIN_BASIS = 3;

export const RULE_QUERIES = {
  shapes: q(
    'rules.goodLawApprovals',
    'ro',
    'Granted exceptions that are good law right now (candidates for a standing rule).',
    `
MATCH (d:Decision:Exception)-[:BECAUSE]->(r:Reason)
WHERE d.outcome = 'approved' AND d.basis IN ['human', 'precedent']
WITH d, r, stare.standing(d, $now).flag AS flag
WHERE flag = 'green'
RETURN d.id AS id, d.policyId AS policyId, r.code AS reason, d.facts AS facts, d.value AS value, d.at AS at`,
  ),
  existing: q(
    'rules.existing',
    'ro',
    'Standing rules already proposed or ratified.',
    `MATCH (s:StandingRule) RETURN s.id AS id, s.policyId AS policyId, s.reasonCode AS reason, s.tiers AS tiers, s.status AS status`,
  ),
  create: q(
    'rules.propose',
    'rw',
    'Propose a standing rule derived from good-law decisions of one shape.',
    `
CREATE (s:StandingRule {id:$id, policyId:$policyId, reasonCode:$reason, tiers:$tiers, maxValue:$maxValue, status:'proposed',
                        createdAt:$now, ratifiedAt:0, text:$text})
WITH s UNWIND $basis AS bid
MATCH (d:Decision {id:bid}) CREATE (s)-[:DERIVED_FROM]->(d)
RETURN s.id AS id, count(d) AS basis`,
  ),
  ratify: q(
    'rules.ratify',
    'rw',
    "Ratify a proposed rule. The ratifier's authority must cover the rule's ceiling now, and every basis decision must still be good law; checked inside the write.",
    `
${LEDGER_HEAD}
MATCH (s:StandingRule {id:$ruleId}) WHERE s.status = 'proposed' AND stare.ruleStatus(s, $now) = 'proposed'
MATCH (p:Person {id:$personId}) WHERE p.leftAt > $now
OPTIONAL MATCH (p)-[h:HOLDS]->(:Role)-[g:MAY_APPROVE]->(:Policy {id:s.policyId})
WHERE h.validFrom <= $now AND $now < h.validTo AND g.validFrom <= $now AND $now < g.validTo
WITH lh, s, p, max(g.cap) AS cap
WHERE cap >= s.maxValue
SET s.status = 'ratified', s.ratifiedAt = $now
CREATE (s)-[:RATIFIED_BY {at:$now}]->(p)
${ledgerWrite(['s'])}
SET s.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(s)
RETURN s.id AS id, le.seq AS seq`,
  ),
  quarantine: q(
    'rules.quarantine',
    'rw',
    'Quarantine every rule whose basis is no longer good law (stare.ruleStatus).',
    `
MATCH (s:StandingRule) WHERE s.status <> 'quarantined'
WITH s, stare.ruleStatus(s, $now) AS st
WHERE st = 'quarantined'
SET s.status = 'quarantined', s.quarantinedAt = $now
RETURN s.id AS id`,
  ),
  list: q(
    'rules.list',
    'ro',
    'Every standing rule with its live status, basis and ratifier (procedural memory).',
    `
MATCH (s:StandingRule)
OPTIONAL MATCH (s)-[:RATIFIED_BY]->(p:Person)
OPTIONAL MATCH (s)-[:DERIVED_FROM]->(d:Decision)-[:ABOUT]->(a:Account)
WITH s, p, collect({id: d.id, account: a.name, at: d.at, value: d.value}) AS basis
RETURN s.id AS id, s.policyId AS policyId, s.reasonCode AS reason, s.tiers AS tiers, s.maxValue AS maxValue, s.text AS text,
       s.status AS stored, stare.ruleStatus(s, $now) AS status, s.createdAt AS createdAt, s.ratifiedAt AS ratifiedAt,
       p.name AS ratifiedBy, basis
ORDER BY s.createdAt`,
  ),
} as const;

const REASON_TEXT: Record<string, string> = {
  outage: 'service outages',
  billing_error: 'billing errors',
  duplicate_charge: 'duplicate charges',
  churn_risk: 'churn risk',
  competitive: 'competitive matches',
  multi_year: 'multi-year commitments',
  expansion: 'seat expansions',
  nonprofit: 'nonprofits',
  procurement_cycle: 'procurement-cycle terms',
  public_sector: 'public-sector statutes',
  cash_flow: 'cash-flow requests',
};

/**
 * Procedural memory: when at least three good-law approvals share a shape (policy, reason, tier),
 * propose a standing rule capped at the smallest of them. Humans ratify; nothing is ratified automatically.
 */
export async function proposeRules(ctx: EngineCtx): Promise<string[]> {
  const now = ctx.clock.now();
  const rows = await ctx.db.ro<{
    id: string;
    policyId: PolicyId;
    reason: string;
    facts: string;
    value: number;
    at: number;
  }>(RULE_QUERIES.shapes, { now });
  const existing = await ctx.db.ro<{ policyId: string; reason: string; tiers: string[]; status: string }>(
    RULE_QUERIES.existing,
  );
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const tier = (JSON.parse(r.facts || '{}').tier ?? '') as string;
    if (!TIERS.includes(tier as (typeof TIERS)[number])) continue;
    const k = `${r.policyId}|${r.reason}|${tier}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const created: string[] = [];
  for (const [k, ds] of groups) {
    if (ds.length < MIN_BASIS) continue;
    const [policyId, reason, tier] = k.split('|') as [PolicyId, string, string];
    if (
      existing.some(
        (e) =>
          e.policyId === policyId &&
          e.reason === reason &&
          e.tiers.includes(tier) &&
          e.status !== 'quarantined',
      )
    )
      continue;
    const basis = ds.sort((a, b) => b.at - a.at).slice(0, 5);
    const maxValue = Math.min(...basis.map((d) => d.value));
    const tiers = TIERS.slice(TIERS.indexOf(tier as (typeof TIERS)[number]));
    const id = `rule-${policyId}-${reason}-${tier}-${randomBytes(2).toString('hex')}`;
    const text = `${policyId === 'refunds' ? 'Refunds' : policyId === 'discounts' ? 'Discounts' : 'Extended terms'} for ${REASON_TEXT[reason] ?? reason}, ${tiers.join(' and ')} accounts, up to ${fmtValue(policyId, maxValue)}.`;
    await ctx.db.rw(RULE_QUERIES.create, {
      id,
      policyId,
      reason,
      tiers: [...tiers],
      maxValue,
      now,
      text,
      basis: basis.map((d) => d.id),
    });
    created.push(id);
    existing.push({ policyId, reason, tiers: [...tiers], status: 'proposed' });
  }
  return created;
}

export async function ratifyRule(
  ctx: EngineCtx,
  ruleId: string,
  personId: string,
): Promise<{ ok: boolean; ledgerSeq: number | null; refusal: string | null }> {
  const now = ctx.clock.now();
  const { rows } = await ctx.db.rw<{ id: string; seq: number }>(RULE_QUERIES.ratify, {
    ruleId,
    personId,
    now,
    ...ledgerParams('rule', ruleId, now, { status: 'ratified', ratifiedBy: personId }),
  });
  if (!rows.length)
    return {
      ok: false,
      ledgerSeq: null,
      refusal: 'not proposed, basis no longer good law, or the ratifier lacks authority for its ceiling',
    };
  return { ok: true, ledgerSeq: rows[0]!.seq, refusal: null };
}

export async function quarantineRules(db: Db, now: number): Promise<string[]> {
  const { rows } = await db.rw<{ id: string }>(RULE_QUERIES.quarantine, { now });
  return rows.map((r) => r.id);
}

export interface RuleView {
  id: string;
  policyId: PolicyId;
  reason: string;
  tiers: string[];
  maxValue: number;
  text: string;
  status: string;
  ratifiedBy: string | null;
  ratifiedAt: number;
  basis: { id: string; account: string; at: number; value: number }[];
}

export async function listRules(db: Db, now: number): Promise<RuleView[]> {
  return db.ro<RuleView>(RULE_QUERIES.list, { now });
}

/** Ratified rules compiled into a SKILL.md any agent runtime can load (procedural memory as a skill). */
export function renderSkill(company: string, rules: RuleView[], now: number): string {
  const d = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const ratified = rules.filter((r) => r.status === 'ratified');
  const quarantined = rules.filter((r) => r.status === 'quarantined');
  const proposed = rules.filter((r) => r.status === 'proposed');
  const line = (r: RuleView) =>
    `- **${r.text}** (\`${r.id}\`) — ${r.policyId}, reason \`${r.reason}\`, tiers ${r.tiers.join('/')}, ceiling ${fmtValue(r.policyId, r.maxValue)}.` +
    `${r.ratifiedBy ? ` Ratified by ${r.ratifiedBy} on ${d(r.ratifiedAt)}.` : ''} Basis: ${r.basis.map((b) => `${b.account} (${d(b.at)}, ${fmtValue(r.policyId, b.value)})`).join('; ')}.`;
  return `---
name: ${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-exception-desk
description: Standing rules ${company} has ratified for granting business exceptions (refunds, discounts, payment terms) without an escalation. Load when acting on customer exception requests for ${company}.
---

# ${company} — standing rules for exceptions

Compiled from the precedent graph on ${d(now)}. Each rule is backed by at least ${MIN_BASIS} decisions that are still good law and was ratified by a person whose authority covers its ceiling. A rule is quarantined the moment any decision it rests on stops being good law.

## How to use these rules

1. File every request with the \`file_exception\` tool. Never grant from this file alone: the desk re-checks the rule's basis, your delegation and the autonomy budget at the moment of the decision.
2. If a request fits a rule below, expect a fast approval citing that rule.
3. Never apply a quarantined or proposed rule.

## Ratified (${ratified.length})

${ratified.map(line).join('\n') || '_None yet._'}

## Proposed, awaiting ratification (${proposed.length})

${proposed.map(line).join('\n') || '_None._'}

## Quarantined — do not use (${quarantined.length})

${quarantined.map(line).join('\n') || '_None._'}
`;
}
