import type { Db, NamedQuery } from './db.ts';
import type { Standing } from './engine/types.ts';

const q = (name: string, mode: 'ro' | 'rw', doc: string, cypher: string): NamedQuery => ({ name, mode, doc, cypher: cypher.trim() });

export const ALGO_QUERIES = {
  leadingCases: q(
    'algo.leadingCases',
    'ro',
    'Leading cases: PageRank over CITES (citations point at the precedent, so authority flows to the decisions the company leans on most), each with its live good-law flag.',
    `
CALL algo.pageRank('Decision', 'CITES') YIELD node, score
WITH node, score ORDER BY score DESC LIMIT $k
OPTIONAL MATCH (node)-[:ABOUT]->(a:Account)
OPTIONAL MATCH (node)-[:MADE_BY]->(m)
OPTIONAL MATCH (node)-[f:PRECEDENT_FOR]->(:Decision)
WITH node, score, a, m, count(f) AS followers
RETURN node.id AS id, a.name AS account, node.policyId AS policyId, node.value AS value, node.at AS at, m.name AS madeBy,
       score, followers, stare.standing(node, $now) AS standing
ORDER BY score DESC`,
  ),
  bottlenecks: q(
    'algo.approvalBottlenecks',
    'ro',
    'Approval bottlenecks: betweenness centrality on the reporting graph, with the escalations waiting on each person.',
    `
CALL algo.betweenness({nodeLabels: ['Person'], relationshipTypes: ['REPORTS_TO']}) YIELD node, score
WITH node, score WHERE node.leftAt > $now
OPTIONAL MATCH (e:Escalation {status:'open'})-[:ROUTED_TO]->(node)
WITH node, score, count(e) AS waiting
RETURN node.id AS id, node.name AS name, node.title AS title, score, waiting
ORDER BY score DESC, waiting DESC LIMIT $k`,
  ),
  clusters: q(
    'algo.exceptionClusters',
    'ro',
    'Exception clusters: label propagation over decisions, their reasons and citations.',
    `
CALL algo.labelPropagation({nodeLabels: ['Decision', 'Reason'], relationshipTypes: ['BECAUSE', 'PRECEDENT_FOR']}) YIELD node, communityId
WITH node, communityId WHERE node:Decision AND node.outcome <> 'denied'
RETURN communityId, node.id AS id, node.policyId AS policyId, node.facts AS facts, node.value AS value, node.basis AS basis,
       stare.standing(node, $now).flag AS flag`,
  ),
  families: q(
    'algo.precedentFamilies',
    'ro',
    'Precedent families: weakly connected components of the citation graph.',
    `
CALL algo.WCC({nodeLabels: ['Decision'], relationshipTypes: ['PRECEDENT_FOR']}) YIELD node, componentId
WITH componentId, count(node) AS size WHERE size > 1
RETURN componentId, size ORDER BY size DESC LIMIT $k`,
  ),
} as const;

export interface LeadingCase {
  id: string;
  account: string;
  policyId: string;
  value: number;
  at: number;
  madeBy: string;
  score: number;
  followers: number;
  standing: Standing;
}

export async function leadingCases(db: Db, now: number, k = 10): Promise<LeadingCase[]> {
  return db.ro<LeadingCase>(ALGO_QUERIES.leadingCases, { k, now });
}

export async function approvalBottlenecks(db: Db, now: number, k = 8) {
  return db.ro<{ id: string; name: string; title: string; score: number; waiting: number }>(ALGO_QUERIES.bottlenecks, { k, now });
}

export interface Cluster {
  communityId: number;
  size: number;
  policyId: string;
  reason: string;
  meanValue: number;
  flags: Record<string, number>;
  ruleCandidate: boolean;
}

export async function exceptionClusters(db: Db, now: number): Promise<Cluster[]> {
  const rows = await db.ro<{ communityId: number; id: string; policyId: string; facts: string; value: number; basis: string; flag: string }>(ALGO_QUERIES.clusters, { now });
  const by = new Map<number, typeof rows>();
  for (const r of rows) by.set(r.communityId, [...(by.get(r.communityId) ?? []), r]);
  return [...by.entries()]
    .filter(([, rs]) => rs.length >= 3)
    .map(([communityId, rs]) => {
      const reasons = rs.map((r) => JSON.parse(r.facts || '{}').reason as string);
      const top = [...new Set(reasons)].sort((a, b) => reasons.filter((x) => x === b).length - reasons.filter((x) => x === a).length)[0] ?? '';
      const flags: Record<string, number> = {};
      for (const r of rs) flags[r.flag] = (flags[r.flag] ?? 0) + 1;
      const exceptions = rs.filter((r) => r.basis !== 'routine');
      return {
        communityId,
        size: rs.length,
        policyId: rs[0]!.policyId,
        reason: top,
        meanValue: Math.round(rs.reduce((s, r) => s + r.value, 0) / rs.length),
        flags,
        ruleCandidate: exceptions.filter((r) => r.flag === 'green').length >= 3,
      };
    })
    .sort((a, b) => b.size - a.size);
}

export async function precedentFamilies(db: Db, k = 8) {
  return db.ro<{ componentId: number; size: number }>(ALGO_QUERIES.families, { k });
}
