import type { Db } from '../src/db.ts';
import { DAY, FOREVER } from '../src/time.ts';

/** Small hand-built world for unit tests. Times are days from T0. */
export const T0 = Date.UTC(2026, 0, 1);
export const d = (n: number) => T0 + n * DAY;

export interface DecisionSpec {
  id: string;
  at: number;
  value: number;
  madeBy: string;
  onAuthorityOf?: string;
  version?: string;
  policyId?: string;
  accountId?: string;
  basis?: 'routine' | 'precedent' | 'rule' | 'human';
  outcome?: 'approved' | 'counter' | 'denied';
  facts?: Record<string, unknown>;
  cites?: string[];
}

export async function baseWorld(db: Db) {
  await db.rw(
    `CREATE (p:Policy {id:'refunds', name:'Refunds', unit:'usd'}),
      (v2:PolicyVersion {id:'refunds-v2', policyId:'refunds', version:2, effectiveFrom:$t0, effectiveTo:$t100}),
      (v3:PolicyVersion {id:'refunds-v3', policyId:'refunds', version:3, effectiveFrom:$t100, effectiveTo:$forever}),
      (v2)-[:VERSION_OF]->(p), (v3)-[:VERSION_OF]->(p), (v3)-[:SUPERSEDES]->(v2),
      (v2)-[:HAS_CLAUSE]->(:Clause {id:'v2-4.1', key:'§4.1', kind:'default', rule:'{"field":"days","op":"lte","value":30}'}),
      (v2)-[:HAS_CLAUSE]->(:Clause {id:'v2-4.2', key:'§4.2', kind:'default', rule:'{"field":"value","op":"lte","value":500}'}),
      (v2)-[:HAS_CLAUSE]->(:Clause {id:'v2-4.5', key:'§4.5', kind:'limit', rule:'{"field":"days","op":"lte","value":120}'}),
      (v3)-[:HAS_CLAUSE]->(:Clause {id:'v3-4.1', key:'§4.1', kind:'default', rule:'{"field":"days","op":"lte","value":30}'}),
      (v3)-[:HAS_CLAUSE]->(:Clause {id:'v3-4.2', key:'§4.2', kind:'default', rule:'{"field":"value","op":"lte","value":500}'}),
      (v3)-[:HAS_CLAUSE]->(:Clause {id:'v3-4.5', key:'§4.5', kind:'limit', rule:'{"field":"days","op":"lte","value":60}'}),
      (lead:Role {id:'support-lead'}), (vpr:Role {id:'vp-cs'}),
      (lead)-[:MAY_APPROVE {cap:1000, validFrom:$t0, validTo:$forever}]->(p),
      (vpr)-[:MAY_APPROVE {cap:5000, validFrom:$t0, validTo:$forever}]->(p),
      (ana:Person {id:'ana', name:'Ana Ruiz', leftAt:$forever}), (vic:Person {id:'vic', name:'Victor Hale', leftAt:$t150}),
      (oli:Person {id:'oli', name:'Oliver Park', leftAt:$forever}), (sam:Person {id:'sam', name:'Sam Lee', leftAt:$forever}),
      (ana)-[:HOLDS {validFrom:$t0, validTo:$forever}]->(lead),
      (vic)-[:HOLDS {validFrom:$t0, validTo:$t150}]->(vpr),
      (oli)-[:HOLDS {validFrom:$t0, validTo:$forever}]->(vpr),
      (sam)-[:HOLDS {validFrom:$t50, validTo:$forever}]->(lead),
      (acc:Account {id:'acme', name:'Acme Logistics', tier:'growth', status:'active'}),
      (oli)-[:OWNS {validFrom:$t0, validTo:$forever}]->(acc),
      (ag:Agent {id:'support-agent', kind:'support'}),
      (ana)-[:DELEGATES {policyId:'refunds', cap:1000, validFrom:$t0, validTo:$forever}]->(ag)`,
    { t0: T0, t50: d(50), t100: d(100), t150: d(150), forever: FOREVER },
  );
}

export async function decision(db: Db, s: DecisionSpec) {
  const facts = {
    policyId: s.policyId ?? 'refunds',
    value: s.value,
    days: 40,
    reason: 'outage',
    tier: 'growth',
    accountStatus: 'active',
    ...s.facts,
  };
  await db.rw(
    `MATCH (pv:PolicyVersion {id:$version}), (m {id:$madeBy})
     CREATE (x:Decision {id:$id, caseId:$id, at:$at, value:$value, policyId:$policyId, accountId:$accountId,
                         basis:$basis, outcome:$outcome, facts:$facts, policyVersionId:$version})
     CREATE (x)-[:APPLIED_POLICY]->(pv), (x)-[:MADE_BY]->(m)
     WITH x
     OPTIONAL MATCH (a:Person {id:$onAuth})
     FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END | CREATE (x)-[:ON_AUTHORITY_OF]->(a))
     WITH x
     UNWIND $cites AS cid
     MATCH (c:Decision {id:cid})
     CREATE (c)-[:PRECEDENT_FOR {similarity:0.9, at:$at}]->(x)`,
    {
      id: s.id,
      at: s.at,
      value: s.value,
      madeBy: s.madeBy,
      onAuth: s.onAuthorityOf ?? '',
      version: s.version ?? 'refunds-v2',
      policyId: s.policyId ?? 'refunds',
      accountId: s.accountId ?? 'acme',
      basis: s.basis ?? 'human',
      outcome: s.outcome ?? 'approved',
      facts: JSON.stringify(facts),
      cites: s.cites ?? [],
    },
  );
}

export async function standing(db: Db, id: string, now: number) {
  const [row] = await db.ro<{ s: { flag: string; reasons: { code: string; detail: string; nodeId: string }[]; chain: string[] } }>(
    'MATCH (x:Decision {id:$id}) RETURN stare.standing(x, $now) AS s',
    { id, now },
  );
  return row!.s;
}
