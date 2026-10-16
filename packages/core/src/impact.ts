import { randomBytes } from 'node:crypto';
import type { FalkorDB } from 'falkordb';
import { copyGraph } from './copy.ts';
import { Db, type NamedQuery } from './db.ts';
import { decide, type EngineCtx } from './engine/decide.ts';
import type { PolicyId, Verdict } from './engine/types.ts';
import { LEDGER_HEAD, ledgerParams, ledgerWrite, sha256Hex } from './ledger.ts';
import { quarantineRules } from './rules.ts';
import { FOREVER } from './time.ts';

const q = (name: string, mode: 'ro' | 'rw', doc: string, cypher: string): NamedQuery => ({
  name,
  mode,
  doc,
  cypher: cypher.trim(),
});

export interface DraftClause {
  key: string;
  kind: 'default' | 'limit';
  text: string;
  rule: { field: string; op: string; value: unknown };
}
export interface PolicyDraft {
  policyId: PolicyId;
  clauses: DraftClause[];
  note?: string;
}

export const IMPACT_QUERIES = {
  flags: q(
    'impact.flags',
    'ro',
    'Good-law flag of every decision at a point in time (one shared memo, in-database).',
    `MATCH (d:Decision) WITH collect(d) AS ds RETURN stare.standingMany(ds, $now) AS flags`,
  ),
  currentClauses: q(
    'impact.currentClauses',
    'ro',
    'The clauses of the version in force, to start a draft from.',
    `
MATCH (:Policy {id:$policyId})<-[:VERSION_OF]-(pv:PolicyVersion)
WHERE pv.effectiveFrom <= $now AND $now < pv.effectiveTo
MATCH (pv)-[:HAS_CLAUSE]->(c:Clause)
RETURN pv.id AS versionId, pv.version AS version, c.key AS key, c.kind AS kind, c.text AS text, c.rule AS rule ORDER BY c.key`,
  ),
  adopt: q(
    'impact.adoptPolicy',
    'rw',
    'Adopt a new policy version: close the one in force, create the new one with its clauses, link SUPERSEDES, record it in the ledger.',
    `
${LEDGER_HEAD}
MATCH (p:Policy {id:$policyId})<-[:VERSION_OF]-(old:PolicyVersion)
WHERE old.effectiveFrom <= $now AND $now < old.effectiveTo
SET old.effectiveTo = $now
CREATE (nv:PolicyVersion {id:$versionId, policyId:$policyId, version:old.version + 1, effectiveFrom:$now, effectiveTo:$forever, text:$text})
CREATE (nv)-[:VERSION_OF]->(p), (nv)-[:SUPERSEDES]->(old)
WITH lh, nv
UNWIND $clauses AS c
CREATE (nv)-[:HAS_CLAUSE]->(:Clause {id:$versionId + '-' + c.key, key:c.key, kind:c.kind, text:c.text, rule:c.rule})
WITH lh, nv, count(*) AS n
${ledgerWrite(['nv'])}
SET nv.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(nv)
RETURN nv.id AS id, nv.version AS version, le.seq AS seq`,
  ),
  replayCases: q(
    'impact.replayCases',
    'ro',
    'The most recent cases under a policy (the fixed replay set for autonomy).',
    `
MATCH (c:Case {policyId:$policyId})-[:FOR]->(a:Account)
WHERE c.text IS NOT NULL AND c.text <> '' AND c.value IS NOT NULL
RETURN c.id AS id, a.name AS account, c.value AS value, c.days AS days, c.reason AS reason, c.at AS at
ORDER BY c.at DESC LIMIT $limit`,
  ),
  rules: q(
    'impact.ruleStatus',
    'ro',
    'Live status of every standing rule (stare.ruleStatus).',
    `MATCH (s:StandingRule) RETURN s.id AS id, s.text AS text, stare.ruleStatus(s, $now) AS status`,
  ),
  depart: q(
    'impact.departPerson',
    'rw',
    'Someone leaves: close their roles, ownerships, delegations and reporting lines. Their past decisions are untouched (authority is judged at the time).',
    `
${LEDGER_HEAD}
MATCH (p:Person {id:$personId}) WHERE p.leftAt > $at
SET p.leftAt = $at
WITH lh, p
OPTIONAL MATCH (p)-[r:HOLDS|OWNS|DELEGATES|MEMBER_OF]->() WHERE r.validTo > $at
WITH lh, p, collect(r) AS rs
FOREACH (x IN rs | SET x.validTo = $at)
WITH lh, p
OPTIONAL MATCH (p)-[rt:REPORTS_TO]-() WHERE rt.validTo > $at
WITH lh, p, collect(rt) AS rts
FOREACH (x IN rts | SET x.validTo = $at, x.dead = 1)
${ledgerWrite(['p'])}
CREATE (le)-[:RECORDS]->(p)
RETURN p.id AS id, le.seq AS seq`,
  ),
  overturn: q(
    'impact.overturn',
    'rw',
    'Overturn a decision: a reversal decision with an OVERTURNS edge. Everything that cites it becomes Overruling Risk at once.',
    `
${LEDGER_HEAD}
MATCH (x:Decision {id:$targetId})-[:DECIDES]->(c:Case)
MATCH (x)-[:APPLIED_POLICY]->(pv:PolicyVersion)
MATCH (p:Person {id:$personId}) WHERE p.leftAt > $now
MATCH (x)-[:ABOUT]->(a:Account)
CREATE (rc:Case {id:$caseId, key:$caseId, policyId:x.policyId, accountId:a.id, value:x.value, reason:'reversal', text:$reason,
                 at:$now, status:'decided', filedBy:$personId})
CREATE (r:Decision {id:$decisionId, caseId:$caseId, outcome:'denied', value:0, requested:x.value, basis:'human', at:$now,
                    policyId:x.policyId, policyVersionId:x.policyVersionId, accountId:a.id, narrative:$reason,
                    facts:'{"reason":"reversal"}'})
CREATE (r)-[:DECIDES]->(rc), (r)-[:MADE_BY]->(p), (r)-[:ABOUT]->(a), (r)-[:APPLIED_POLICY]->(pv), (rc)-[:FOR]->(a)
CREATE (r)-[:OVERTURNS {reason:$reason, at:$now}]->(x)
${ledgerWrite(['r'])}
SET r.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(r)
RETURN r.id AS id, le.seq AS seq`,
  ),
  citedBy: q(
    'impact.citedBy',
    'ro',
    'Decisions that rely on a decision, directly or through a chain of citations.',
    `
MATCH (x:Decision {id:$id})-[:PRECEDENT_FOR*1..6]->(d:Decision)
RETURN DISTINCT d.id AS id`,
  ),
} as const;

export interface FlagMap {
  [id: string]: { flag: string; codes: string[] };
}

export async function flagsAt(db: Db, now: number): Promise<FlagMap> {
  const [row] = await db.ro<{ flags: { id: string; flag: string; reasons: { code: string }[] }[] }>(
    IMPACT_QUERIES.flags,
    { now },
  );
  const out: FlagMap = {};
  for (const f of row?.flags ?? []) out[f.id] = { flag: f.flag, codes: f.reasons.map((r) => r.code) };
  return out;
}

export interface ImpactReport {
  policyId: PolicyId;
  whatIfGraph: string;
  transitions: { from: string; to: string; count: number; ids: string[] }[];
  becameRed: number;
  becameYellow: number;
  rulesQuarantined: { id: string; text: string }[];
  autonomy: { before: number; after: number; sample: number };
  exposure: number;
  ms: number;
}

const AGENT_FOR: Record<PolicyId, string> = {
  refunds: 'a-support',
  discounts: 'a-renewals',
  payment_terms: 'a-billing',
};

async function autonomy(
  ctx: EngineCtx,
  db: Db,
  policyId: PolicyId,
  cases: { account: string; value: number; days: number | null; reason: string }[],
) {
  let auto = 0;
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const c = cases[next++]!;
      const v: Verdict = await decide(
        { ...ctx, db },
        {
          principal: { kind: 'agent', id: AGENT_FOR[policyId] },
          intake: {
            policyId,
            accountName: c.account,
            value: c.value,
            days: c.days,
            reason: c.reason,
            claims: [],
          },
          dryRun: true,
        },
      );
      if (v.outcome === 'approved' || v.outcome === 'counter') auto++;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return cases.length ? Math.round((auto / cases.length) * 1000) / 10 : 0;
}

/**
 * Simulate adopting a draft policy on a GRAPH.COPY of the tenant (a sandbox): which precedents stop
 * being good law, which standing rules get quarantined, and how much autonomy the agents lose.
 * The live graph is never touched; the copy is dropped afterwards.
 */
export async function policyImpact(
  admin: FalkorDB,
  ctx: EngineCtx,
  draft: PolicyDraft,
  opts: { replay?: number } = {},
): Promise<ImpactReport> {
  const t0 = performance.now();
  const now = ctx.clock.now();
  const whatIf = `${ctx.db.graphName}:whatif:${randomBytes(4).toString('hex')}`;
  await copyGraph(admin, ctx.db.graphName, whatIf);
  const sim = new Db(ctx.db.client, whatIf, ctx.db.recorder);
  try {
    const cases = await ctx.db.ro<{ account: string; value: number; days: number | null; reason: string }>(
      IMPACT_QUERIES.replayCases,
      { policyId: draft.policyId, limit: opts.replay ?? 30 },
    );
    const before = await flagsAt(ctx.db, now);
    const rulesBefore = await ctx.db.ro<{ id: string; text: string; status: string }>(IMPACT_QUERIES.rules, {
      now,
    });
    const autoBefore = await autonomy(ctx, ctx.db, draft.policyId, cases);

    await sim.rw(IMPACT_QUERIES.adopt, adoptParams(draft, now));
    const after = await flagsAt(sim, now + 1);
    const rulesAfter = await sim.ro<{ id: string; text: string; status: string }>(IMPACT_QUERIES.rules, {
      now: now + 1,
    });
    const autoAfter = await autonomy({ ...ctx, clock: { now: () => now + 1 } }, sim, draft.policyId, cases);

    const trans = new Map<string, string[]>();
    for (const [id, b] of Object.entries(before)) {
      const a = after[id];
      if (!a || a.flag === b.flag) continue;
      const k = `${b.flag}→${a.flag}`;
      trans.set(k, [...(trans.get(k) ?? []), id]);
    }
    const values = await sim.ro<{ id: string; value: number }>(
      'MATCH (d:Decision) RETURN d.id AS id, d.value AS value',
    );
    const valueById = new Map(values.map((x) => [x.id, x.value]));
    const red = [...trans.entries()].filter(([k]) => k.endsWith('→red')).flatMap(([, ids]) => ids);
    return {
      policyId: draft.policyId,
      whatIfGraph: whatIf,
      transitions: [...trans.entries()].map(([k, ids]) => ({
        from: k.split('→')[0]!,
        to: k.split('→')[1]!,
        count: ids.length,
        ids,
      })),
      becameRed: red.length,
      becameYellow: [...trans.entries()]
        .filter(([k]) => k.endsWith('→yellow'))
        .reduce((s, [, ids]) => s + ids.length, 0),
      rulesQuarantined: rulesAfter
        .filter(
          (r) =>
            r.status === 'quarantined' && rulesBefore.find((x) => x.id === r.id)?.status !== 'quarantined',
        )
        .map((r) => ({ id: r.id, text: r.text })),
      autonomy: { before: autoBefore, after: autoAfter, sample: cases.length },
      exposure: red.reduce((s, id) => s + (valueById.get(id) ?? 0), 0),
      ms: Math.round(performance.now() - t0),
    };
  } finally {
    await admin
      .selectGraph(whatIf)
      .delete()
      .catch(() => {});
  }
}

function adoptParams(draft: PolicyDraft, now: number) {
  const versionId = `${draft.policyId}-v${now}`;
  const text = draft.clauses.map((c) => `${c.key} ${c.text}`).join('\n');
  return {
    policyId: draft.policyId,
    versionId,
    now,
    forever: FOREVER,
    text,
    clauses: draft.clauses.map((c) => ({ ...c, rule: JSON.stringify(c.rule) })),
    ...ledgerParams('policy', versionId, now, {
      policyId: draft.policyId,
      textHash: sha256Hex(text),
      note: draft.note ?? null,
    }),
  };
}

export async function adoptPolicy(ctx: EngineCtx, draft: PolicyDraft) {
  const now = ctx.clock.now();
  const { rows } = await ctx.db.rw<{ id: string; version: number; seq: number }>(
    IMPACT_QUERIES.adopt,
    adoptParams(draft, now),
  );
  const quarantined = await quarantineRules(ctx.db, now + 1);
  return {
    versionId: rows[0]?.id ?? null,
    version: rows[0]?.version ?? null,
    ledgerSeq: rows[0]?.seq ?? null,
    quarantined,
  };
}

export async function draftFromCurrent(ctx: EngineCtx, policyId: PolicyId): Promise<PolicyDraft> {
  const rows = await ctx.db.ro<{ key: string; kind: 'default' | 'limit'; text: string; rule: string }>(
    IMPACT_QUERIES.currentClauses,
    { policyId, now: ctx.clock.now() },
  );
  return {
    policyId,
    clauses: rows.map((r) => ({ key: r.key, kind: r.kind, text: r.text, rule: JSON.parse(r.rule) })),
  };
}

export async function departPerson(ctx: EngineCtx, personId: string) {
  const at = ctx.clock.now();
  const { rows } = await ctx.db.rw<{ id: string; seq: number }>(IMPACT_QUERIES.depart, {
    personId,
    at,
    ...ledgerParams('departure', personId, at, { personId }),
  });
  return { ok: rows.length > 0, ledgerSeq: rows[0]?.seq ?? null };
}

export async function overturnDecision(ctx: EngineCtx, targetId: string, personId: string, reason: string) {
  const now = ctx.clock.now();
  const decisionId = `dec-${randomBytes(5).toString('hex')}`;
  const caseId = `case-${randomBytes(5).toString('hex')}`;
  const [target] = await ctx.db.ro<{ pv: string; accountId: string }>(
    'MATCH (x:Decision {id:$id}) RETURN x.policyVersionId AS pv, x.accountId AS accountId',
    { id: targetId },
  );
  if (!target) return { ok: false, decisionId: null, affected: [], quarantined: [] };
  const payload = {
    caseId,
    outcome: 'denied',
    value: 0,
    basis: 'human',
    policyVersionId: target.pv,
    madeBy: personId,
    at: now,
    onAuthorityOf: null,
    accountId: target.accountId,
    cites: [],
    subjectCommitment: null,
    overturns: targetId,
    reasonHash: sha256Hex(reason),
  };
  const { rows } = await ctx.db.rw<{ id: string; seq: number }>(IMPACT_QUERIES.overturn, {
    targetId,
    personId,
    reason,
    now,
    decisionId,
    caseId,
    ...ledgerParams('decision', decisionId, now, payload),
  });
  if (!rows.length) return { ok: false, decisionId: null, affected: [], quarantined: [] };
  const affected = (await ctx.db.ro<{ id: string }>(IMPACT_QUERIES.citedBy, { id: targetId })).map(
    (r) => r.id,
  );
  const quarantined = await quarantineRules(ctx.db, now + 1);
  return { ok: true, decisionId: rows[0]!.id, ledgerSeq: rows[0]!.seq, affected, quarantined };
}
