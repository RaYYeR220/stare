import { randomBytes } from 'node:crypto';
import {
  applySchema,
  type Db,
  type Embedder,
  LEDGER_HEAD,
  ledgerParams,
  ledgerWrite,
  Q_LEDGER_INIT,
  sha256Hex,
} from '@stare/core';
import type { DecisionRow, TenantData } from './model.ts';

const BATCH = 200;

async function unwind(db: Db, rows: unknown[], cypher: string, name: string) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.rw(
      { name: `seed.${name}`, mode: 'rw', doc: `Seed: ${name}`, cypher: `UNWIND $rows AS r\n${cypher}` },
      { rows: rows.slice(i, i + BATCH) },
    );
  }
}

/** Commitment that binds a ledger entry to a data subject without storing who they are. */
export function subjectCommitment(salt: string, contactId: string): string {
  return sha256Hex(`${salt}|${contactId}`);
}

export function decisionLedgerPayload(d: DecisionRow, commitment: string | null) {
  return {
    caseId: d.caseId,
    outcome: d.outcome,
    value: d.value,
    basis: d.basis,
    policyVersionId: d.policyVersionId,
    madeBy: d.madeBy,
    at: d.at,
    onAuthorityOf: d.onAuthorityOf,
    accountId: d.accountId,
    cites: d.cites.map((c) => c.id),
    subjectCommitment: commitment,
  };
}

export interface SeedOptions {
  embedder: Embedder;
  /** "now" used to mark ended reporting lines as dead for routing. */
  now?: number;
  log?: (msg: string) => void;
  /** Skip index/constraint creation when the graph was copied from a template that has them. */
  skipSchema?: boolean;
}

export async function seedGraph(
  db: Db,
  t: TenantData,
  opts: SeedOptions,
): Promise<{ salts: Map<string, string> }> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now();
  if (!opts.skipSchema) await applySchema(db, opts.embedder.dim);

  log('org');
  await unwind(db, t.teams, 'CREATE (:Team {id:r.id, name:r.name})', 'teams');
  await unwind(
    db,
    t.people,
    'CREATE (:Person {id:r.id, name:r.name, email:r.email, title:r.title, joinedAt:r.joinedAt, leftAt:r.leftAt})',
    'people',
  );
  await unwind(
    db,
    t.members,
    'MATCH (p:Person {id:r.person}), (x:Team {id:r.team}) CREATE (p)-[:MEMBER_OF {validFrom:r.validFrom, validTo:r.validTo}]->(x)',
    'members',
  );
  await unwind(db, t.roles, 'CREATE (:Role {id:r.id, name:r.name})', 'roles');
  await unwind(
    db,
    t.holds,
    'MATCH (p:Person {id:r.person}), (x:Role {id:r.role}) CREATE (p)-[:HOLDS {validFrom:r.validFrom, validTo:r.validTo}]->(x)',
    'holds',
  );
  await unwind(
    db,
    t.reports.map((r) => ({ ...r, dead: r.validTo <= now ? 1 : 0 })),
    'MATCH (p:Person {id:r.person}), (m:Person {id:r.manager}) CREATE (p)-[:REPORTS_TO {validFrom:r.validFrom, validTo:r.validTo, w:1, dead:r.dead}]->(m)',
    'reports',
  );
  await unwind(
    db,
    t.policies,
    'CREATE (:Policy {id:r.id, name:r.name, unit:r.unit, owner:r.owner})',
    'policies',
  );
  await unwind(
    db,
    t.grants,
    'MATCH (x:Role {id:r.role}), (p:Policy {id:r.policy}) CREATE (x)-[:MAY_APPROVE {cap:r.cap, validFrom:r.validFrom, validTo:r.validTo}]->(p)',
    'grants',
  );
  await unwind(
    db,
    t.agents,
    'CREATE (:Agent {id:r.id, name:r.name, kind:r.kind, policyId:r.policyId, deployedAt:r.deployedAt})',
    'agents',
  );
  await unwind(
    db,
    t.delegations,
    'MATCH (p:Person {id:r.person}), (a:Agent {id:r.agent}) CREATE (p)-[:DELEGATES {policyId:r.policyId, cap:r.cap, validFrom:r.validFrom, validTo:r.validTo}]->(a)',
    'delegations',
  );

  log('accounts');
  await unwind(
    db,
    t.accounts,
    'CREATE (:Account {id:r.id, name:r.name, domain:r.domain, tier:r.tier, arr:r.arr, region:r.region, status:r.status, renewalAt:r.renewalAt})',
    'accounts',
  );
  const salts = new Map(t.contacts.map((c) => [c.id, randomBytes(32).toString('hex')]));
  await unwind(
    db,
    t.contacts.map((c) => ({ ...c, salt: salts.get(c.id) })),
    `MATCH (a:Account {id:r.account})
     CREATE (c:Contact {id:r.id, name:r.name, email:r.email, phone:r.phone, title:r.title})-[:CONTACT_OF]->(a)
     CREATE (c)-[:SALTED_BY]->(:Salt {id:'salt-' + r.id, value:r.salt})`,
    'contacts',
  );
  await unwind(
    db,
    t.owns,
    'MATCH (p:Person {id:r.person}), (a:Account {id:r.account}) CREATE (p)-[:OWNS {validFrom:r.validFrom, validTo:r.validTo}]->(a)',
    'owns',
  );

  log('policy versions');
  await unwind(
    db,
    t.versions,
    `MATCH (p:Policy {id:r.policyId})
     CREATE (v:PolicyVersion {id:r.id, policyId:r.policyId, version:r.version, effectiveFrom:r.effectiveFrom, effectiveTo:r.effectiveTo, text:r.text})-[:VERSION_OF]->(p)`,
    'versions',
  );
  await unwind(
    db,
    t.versions
      .filter((v) => v.version > 1)
      .map((v) => ({ id: v.id, prev: `${v.policyId}-v${v.version - 1}` })),
    'MATCH (v:PolicyVersion {id:r.id}), (p:PolicyVersion {id:r.prev}) CREATE (v)-[:SUPERSEDES]->(p)',
    'supersedes',
  );
  await unwind(
    db,
    t.clauses.map((c) => ({ ...c, rule: JSON.stringify(c.rule) })),
    'MATCH (v:PolicyVersion {id:r.versionId}) CREATE (v)-[:HAS_CLAUSE]->(:Clause {id:r.id, key:r.key, kind:r.kind, text:r.text, rule:r.rule})',
    'clauses',
  );

  log('incidents + sources');
  await unwind(
    db,
    t.incidents,
    `CREATE (i:Incident {id:r.id, title:r.title, startedAt:r.startedAt, endedAt:r.endedAt, severity:r.severity})
     WITH i, r UNWIND r.accounts AS aid MATCH (a:Account {id:aid}) CREATE (i)-[:AFFECTED]->(a)`,
    'incidents',
  );
  await unwind(
    db,
    t.sources,
    'CREATE (:Source {id:r.id, kind:r.kind, title:r.title, channel:r.channel, at:r.at})',
    'sources',
  );

  log('embeddings');
  const decisionText = (d: DecisionRow) =>
    `${d.narrative}\n${t.cases.find((c) => c.id === d.caseId)?.text ?? ''}`;
  const embed = async (texts: string[]) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64)
      out.push(...(await opts.embedder.embed(texts.slice(i, i + 64))));
    return out;
  };
  const spanVec = await embed(t.spans.map((s) => s.text));
  const factVec = await embed(t.facts.map((f) => f.text));
  const decVec = await embed(t.decisions.map(decisionText));
  const epVec = await embed(t.episodes.map((e) => e.summary));

  await unwind(
    db,
    t.spans.map((s, i) => ({ ...s, emb: spanVec[i] })),
    `MATCH (src:Source {id:r.sourceId})
     CREATE (s:Span {id:r.id, text:r.text, at:r.at, author:r.author, embedding:vecf32(r.emb)})-[:IN]->(src)
     WITH s, r UNWIND r.mentions AS mid MATCH (m {id:mid}) WHERE m:Contact OR m:Account OR m:Person OR m:Agent
     CREATE (s)-[:MENTIONS]->(m)`,
    'spans',
  );
  await unwind(
    db,
    t.facts.map((f, i) => ({ ...f, emb: factVec[i] })),
    `CREATE (f:Fact {id:r.id, text:r.text, at:r.at, embedding:vecf32(r.emb)})
     WITH f, r UNWIND r.derivedFrom AS sid MATCH (s:Span {id:sid}) CREATE (f)-[:DERIVED_FROM]->(s)`,
    'facts',
  );
  await unwind(
    db,
    t.facts.flatMap((f) => f.about.map((a) => ({ f: f.id, a }))),
    'MATCH (f:Fact {id:r.f}), (x {id:r.a}) WHERE x:Account OR x:Contact OR x:Person CREATE (f)-[:ABOUT]->(x)',
    'fact-about',
  );

  log('cases + decisions');
  const reasons = [...new Set([...t.cases.map((c) => c.reason), ...t.decisions.map((d) => d.reason)])];
  await unwind(
    db,
    reasons.map((code) => ({ code })),
    "CREATE (:Reason {id:'reason-' + r.code, code:r.code})",
    'reasons',
  );
  await unwind(
    db,
    t.cases,
    `MATCH (a:Account {id:r.accountId}), (rs:Reason {code:r.reason})
     CREATE (c:Case {id:r.id, key:r.key, policyId:r.policyId, accountId:r.accountId, value:r.value, days:r.days, reason:r.reason,
                     tier:r.tier, accountStatus:r.accountStatus, text:r.text, at:r.at, status:r.status, filedBy:r.filedBy})
     CREATE (c)-[:FOR]->(a), (c)-[:BECAUSE]->(rs)
     WITH c, r MATCH (f {id:r.filedBy}) WHERE f:Person OR f:Agent CREATE (c)-[:FILED_BY]->(f)`,
    'cases',
  );
  await unwind(
    db,
    t.cases.filter((c) => c.contactId),
    'MATCH (c:Case {id:r.id}), (k:Contact {id:r.contactId}) CREATE (c)-[:REQUESTED_BY]->(k)',
    'case-contact',
  );
  await unwind(
    db,
    t.decisions.map((d, i) => ({
      ...d,
      facts: JSON.stringify(d.facts),
      emb: decVec[i],
      exception: d.basis !== 'routine' && d.outcome !== 'denied',
    })),
    `MATCH (c:Case {id:r.caseId}), (pv:PolicyVersion {id:r.policyVersionId}), (m {id:r.madeBy}), (a:Account {id:r.accountId}), (rs:Reason {code:r.reason})
     WHERE m:Person OR m:Agent
     CREATE (d:Decision {id:r.id, caseId:r.caseId, outcome:r.outcome, value:r.value, basis:r.basis, at:r.at, policyId:r.policyId,
                         policyVersionId:r.policyVersionId, accountId:r.accountId, facts:r.facts, narrative:r.narrative,
                         embedding:vecf32(r.emb)})
     CREATE (d)-[:DECIDES]->(c), (d)-[:APPLIED_POLICY]->(pv), (d)-[:MADE_BY]->(m), (d)-[:ABOUT]->(a), (d)-[:BECAUSE]->(rs)
     FOREACH (_ IN CASE WHEN r.exception THEN [1] ELSE [] END | SET d:Exception)`,
    'decisions',
  );
  await unwind(
    db,
    t.decisions.filter((d) => d.onAuthorityOf),
    'MATCH (d:Decision {id:r.id}), (p:Person {id:r.onAuthorityOf}) CREATE (d)-[:ON_AUTHORITY_OF]->(p)',
    'on-authority',
  );
  await unwind(
    db,
    t.decisions.flatMap((d) => d.groundedIn.map((s) => ({ d: d.id, s }))),
    'MATCH (d:Decision {id:r.d}), (s:Span {id:r.s}) CREATE (d)-[:GROUNDED_IN]->(s)',
    'grounded',
  );
  await unwind(
    db,
    t.decisions.flatMap((d) => d.cites.map((c) => ({ d: d.id, p: c.id, sim: c.similarity, at: d.at }))),
    'MATCH (d:Decision {id:r.d}), (p:Decision {id:r.p}) CREATE (p)-[:PRECEDENT_FOR {similarity:r.sim, at:r.at}]->(d), (d)-[:CITES]->(p)',
    'precedent-for',
  );
  await unwind(
    db,
    t.decisions
      .filter((d) => d.overturns)
      .map((d) => ({ d: d.id, target: d.overturns!.id, reason: d.overturns!.reason, at: d.at })),
    'MATCH (d:Decision {id:r.d}), (x:Decision {id:r.target}) CREATE (d)-[:OVERTURNS {reason:r.reason, at:r.at}]->(x)',
    'overturns',
  );
  await unwind(
    db,
    t.escalations,
    `MATCH (c:Case {id:r.caseId}), (p:Person {id:r.routedTo})
     CREATE (e:Escalation {id:r.id, caseId:r.caseId, status:r.status, at:r.at, pathIds:r.pathIds})-[:FOR]->(c)
     CREATE (e)-[:ROUTED_TO]->(p)
     WITH e, r MATCH (d:Decision {id:coalesce(r.resolvedBy, '-')}) CREATE (e)-[:RESOLVED_BY]->(d)`,
    'escalations',
  );
  await unwind(
    db,
    t.budgets,
    'CREATE (:Budget {id:r.id, policyId:r.policyId, period:r.period, unit:r.unit, cap:r.cap, remaining:r.remaining, from:r.from, to:r.to, version:0})',
    'budgets',
  );
  await unwind(
    db,
    t.rules,
    `CREATE (s:StandingRule {id:r.id, policyId:r.policyId, reasonCode:r.reasonCode, tiers:r.tiers, maxValue:r.maxValue, status:r.status,
                             createdAt:r.createdAt, ratifiedAt:coalesce(r.ratifiedAt, 0), text:r.text})
     WITH s, r UNWIND r.derivedFrom AS did MATCH (d:Decision {id:did}) CREATE (s)-[:DERIVED_FROM]->(d)`,
    'rules',
  );
  await unwind(
    db,
    t.rules.filter((r) => r.ratifiedBy),
    'MATCH (s:StandingRule {id:r.id}), (p:Person {id:r.ratifiedBy}) CREATE (s)-[:RATIFIED_BY {at:r.ratifiedAt}]->(p)',
    'ratified',
  );

  log('memory');
  await unwind(
    db,
    t.episodes.map((e, i) => ({ ...e, emb: epVec[i] })),
    `MATCH (a:Agent {id:r.agentId})
     CREATE (a)-[:HAD]->(e:Episode {id:r.id, agentId:r.agentId, sessionId:r.sessionId, at:r.at, summary:r.summary, embedding:vecf32(r.emb)})
     WITH e, r UNWIND r.about AS x MATCH (n {id:x}) WHERE n:Account OR n:Case CREATE (e)-[:ABOUT]->(n)`,
    'episodes',
  );
  for (const agent of t.agents) {
    const eps = t.episodes.filter((e) => e.agentId === agent.id).sort((a, b) => a.at - b.at);
    await unwind(
      db,
      eps.slice(1).map((e, i) => ({ a: eps[i]!.id, b: e.id })),
      'MATCH (x:Episode {id:r.a}), (y:Episode {id:r.b}) CREATE (x)-[:NEXT]->(y)',
      'episode-next',
    );
  }
  await unwind(
    db,
    t.handoffs,
    `MATCH (f:Agent {id:r.from}), (to:Agent {id:r.to}), (c:Case {id:r.caseId})
     CREATE (f)-[:HANDED_OFF]->(h:Handoff {id:r.id, caseId:r.caseId, note:r.note, at:r.at, status:r.status})-[:TO]->(to)
     CREATE (h)-[:FOR]->(c)`,
    'handoffs',
  );

  log('ledger');
  await db.rw(Q_LEDGER_INIT);
  const contactOfCase = new Map(t.cases.map((c) => [c.id, c.contactId]));
  type Ev = {
    at: number;
    kind: 'policy' | 'decision' | 'rule';
    id: string;
    payload: Record<string, unknown>;
    label: string;
  };
  const events: Ev[] = [
    ...t.versions.map((v) => ({
      at: v.effectiveFrom,
      kind: 'policy' as const,
      id: v.id,
      label: 'PolicyVersion',
      payload: {
        policyId: v.policyId,
        version: v.version,
        effectiveFrom: v.effectiveFrom,
        textHash: sha256Hex(v.text),
      },
    })),
    ...t.decisions.map((d) => {
      const cid = contactOfCase.get(d.caseId);
      return {
        at: d.at,
        kind: 'decision' as const,
        id: d.id,
        label: 'Decision',
        payload: decisionLedgerPayload(d, cid ? subjectCommitment(salts.get(cid)!, cid) : null),
      };
    }),
    ...t.rules
      .filter((r) => r.ratifiedAt)
      .map((r) => ({
        at: r.ratifiedAt!,
        kind: 'rule' as const,
        id: r.id,
        label: 'StandingRule',
        payload: {
          status: 'ratified',
          ratifiedBy: r.ratifiedBy,
          maxValue: r.maxValue,
          derivedFrom: r.derivedFrom,
        },
      })),
  ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const e of events) {
    await db.rw(
      {
        name: 'seed.ledger',
        mode: 'rw',
        doc: 'Seed: append one historical event to the ledger',
        cypher: `${LEDGER_HEAD} MATCH (x:${e.label} {id:$ledgerRefId}) ${ledgerWrite(['x'])}
SET x.ledgerSeq = le.seq CREATE (le)-[:RECORDS]->(x)`,
      },
      ledgerParams(e.kind, e.id, e.at, e.payload),
    );
  }
  log('done');
  return { salts };
}
