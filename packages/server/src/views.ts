import type { Db, NamedQuery, Standing } from '@stare/core';

const q = (name: string, doc: string, cypher: string): NamedQuery => ({ name, mode: 'ro', doc, cypher: cypher.trim() });

/** Read models for the desk. Every one is a named query, shown in the "Cypher that ran" panel. */
export const VIEW_QUERIES = {
  overview: q(
    'desk.overview',
    'Headline numbers for the desk: decisions by flag, open escalations, autonomy budgets, ledger head.',
    `
MATCH (d:Decision) WITH collect(d) AS ds
WITH ds, stare.standingMany(ds, $now) AS flags
OPTIONAL MATCH (e:Escalation {status:'open'})
WITH ds, flags, count(e) AS open
OPTIONAL MATCH (lh:LedgerHead {id:'head'})
RETURN size(ds) AS decisions, size([f IN flags WHERE f.flag = 'green']) AS green, size([f IN flags WHERE f.flag = 'yellow']) AS yellow,
       size([f IN flags WHERE f.flag = 'red']) AS red, open, lh.seq AS ledgerSeq, lh.hash AS ledgerHead`,
  ),
  budgets: q('desk.budgets', 'Autonomy budgets in force.', `MATCH (b:Budget) WHERE b.from <= $now AND $now < b.to RETURN b.id AS id, b.policyId AS policyId, b.unit AS unit, b.cap AS cap, b.remaining AS remaining ORDER BY b.policyId`),
  agents: q(
    'desk.agents',
    'Each agent, its live delegations and its last episode.',
    `
MATCH (a:Agent)
OPTIONAL MATCH (p:Person)-[d:DELEGATES]->(a) WHERE d.validFrom <= $now AND $now < d.validTo AND p.leftAt > $now
WITH a, collect({person: p.name, personId: p.id, cap: d.cap, policyId: d.policyId}) AS delegations
OPTIONAL MATCH (a)-[:HAD]->(e:Episode)
WITH a, delegations, e ORDER BY e.at DESC
WITH a, delegations, collect(e)[0] AS last
RETURN a.id AS id, a.name AS name, a.kind AS kind, a.policyId AS policyId, delegations, last.summary AS lastEpisode, last.at AS lastAt`,
  ),
  cases: q(
    'desk.cases',
    'Most recent cases with their outcome.',
    `
MATCH (c:Case)-[:FOR]->(a:Account)
WITH c, a ORDER BY c.at DESC LIMIT $limit
OPTIONAL MATCH (d:Decision)-[:DECIDES]->(c)
OPTIONAL MATCH (e:Escalation)-[:FOR]->(c)
OPTIONAL MATCH (e)-[:ROUTED_TO]->(p:Person)
RETURN c.id AS id, c.at AS at, c.policyId AS policyId, c.value AS value, c.reason AS reason, c.text AS text, c.status AS status, c.filedBy AS filedBy,
       a.name AS account, d.id AS decisionId, d.outcome AS outcome, d.value AS granted, d.basis AS basis, e.id AS escalationId, e.status AS escalationStatus, p.name AS routedTo
ORDER BY c.at DESC`,
  ),
  decision: q(
    'desk.decision',
    'One decision with its maker, authority, policy version, account and live standing.',
    `
MATCH (d:Decision {id:$id})
OPTIONAL MATCH (d)-[:MADE_BY]->(m)
OPTIONAL MATCH (d)-[:ON_AUTHORITY_OF]->(o:Person)
OPTIONAL MATCH (d)-[:APPLIED_POLICY]->(pv:PolicyVersion)
OPTIONAL MATCH (d)-[:ABOUT]->(a:Account)
OPTIONAL MATCH (d)-[:DECIDES]->(c:Case)
OPTIONAL MATCH (d)-[:CITES_RULE]->(r:StandingRule)
OPTIONAL MATCH (le:LedgerEntry)-[:RECORDS]->(d)
RETURN d.id AS id, d.outcome AS outcome, d.value AS value, d.requested AS requested, d.basis AS basis, d.at AS at, d.policyId AS policyId,
       d.narrative AS narrative, d.facts AS facts, m.id AS madeById, m.name AS madeBy, labels(m)[0] AS makerKind, o.name AS onAuthorityOf,
       pv.id AS policyVersion, a.name AS account, a.tier AS tier, c.id AS caseId, c.text AS request, r.text AS rule,
       le.seq AS ledgerSeq, le.hash AS ledgerHash, stare.standing(d, $now) AS standing`,
  ),
  citations: q(
    'desk.citationChain',
    'The precedent chain behind a decision (CITES, up to four hops), each link with its live flag.',
    `
MATCH p = (:Decision {id:$id})-[:CITES*1..4]->(:Decision)
UNWIND relationships(p) AS r
WITH DISTINCT startNode(r) AS a, endNode(r) AS b
OPTIONAL MATCH (b)-[:ABOUT]->(acc:Account)
OPTIONAL MATCH (b)-[:MADE_BY]->(m)
RETURN a.id AS from, b.id AS to, acc.name AS account, b.value AS value, b.at AS at, m.name AS madeBy, stare.standing(b, $now) AS standing`,
  ),
  overturnedBy: q(
    'desk.overturnedBy',
    'Reversals affecting a decision or anything in its chain.',
    `
MATCH (r:Decision)-[o:OVERTURNS]->(x:Decision) WHERE x.id IN $ids
OPTIONAL MATCH (r)-[:MADE_BY]->(p:Person)
RETURN x.id AS target, r.id AS by, p.name AS person, o.reason AS reason, o.at AS at`,
  ),
  sources: q(
    'desk.sources',
    'The messages a decision is grounded in (and erasure tombstones).',
    `
MATCH (d:Decision {id:$id})-[:GROUNDED_IN]->(g)
OPTIONAL MATCH (g)-[:IN]->(src:Source)
RETURN labels(g)[0] AS kind, g.id AS id, g.text AS text, g.at AS at, g.author AS author, src.channel AS channel, src.title AS title, g.certificateHash AS certificateHash
ORDER BY g.at`,
  ),
  inbox: q(
    'desk.inbox',
    'Open escalations, with who they are routed to and why.',
    `
MATCH (e:Escalation {status:'open'})-[:FOR]->(c:Case)-[:FOR]->(a:Account)
OPTIONAL MATCH (e)-[:ROUTED_TO]->(p:Person)
RETURN e.id AS id, e.at AS at, e.why AS why, e.pathIds AS pathIds, c.id AS caseId, c.policyId AS policyId, c.value AS value, c.reason AS reason,
       c.text AS text, a.name AS account, p.id AS routedToId, p.name AS routedTo
ORDER BY e.at DESC`,
  ),
  people: q(
    'desk.people',
    'People with their current roles and approval authority per policy.',
    `
MATCH (p:Person)
OPTIONAL MATCH (p)-[h:HOLDS]->(r:Role) WHERE h.validFrom <= $now AND $now < h.validTo
OPTIONAL MATCH (r)-[g:MAY_APPROVE]->(pol:Policy) WHERE g.validFrom <= $now AND $now < g.validTo
WITH p, collect(DISTINCT r.name) AS roles, collect(DISTINCT {policy: pol.id, cap: g.cap}) AS caps
RETURN p.id AS id, p.name AS name, p.title AS title, p.leftAt > $now AS active, roles, [c IN caps WHERE c.policy IS NOT NULL] AS authority
ORDER BY p.name`,
  ),
  contacts: q(
    'desk.contacts',
    'Customer contacts (data subjects) with how much of the graph mentions them.',
    `
MATCH (k:Contact)-[:CONTACT_OF]->(a:Account)
OPTIONAL MATCH (s:Span)-[:MENTIONS]->(k)
WITH k, a, count(s) AS mentions
RETURN k.id AS id, k.name AS name, k.title AS title, a.name AS account, mentions
ORDER BY mentions DESC, k.name LIMIT $limit`,
  ),
  policies: q(
    'desk.policies',
    'Every policy version with its clauses.',
    `
MATCH (p:Policy)<-[:VERSION_OF]-(v:PolicyVersion)
OPTIONAL MATCH (v)-[:HAS_CLAUSE]->(c:Clause)
WITH p, v, collect({key: c.key, kind: c.kind, text: c.text, rule: c.rule}) AS clauses
RETURN p.id AS policyId, p.name AS name, p.unit AS unit, v.id AS versionId, v.version AS version, v.effectiveFrom AS from, v.effectiveTo AS to,
       v.effectiveFrom <= $now AND $now < v.effectiveTo AS current, clauses
ORDER BY p.id, v.version`,
  ),
  ledgerTail: q(
    'desk.ledgerTail',
    'The most recent ledger entries.',
    `MATCH (e:LedgerEntry) RETURN e.seq AS seq, e.kind AS kind, e.refId AS refId, e.hash AS hash, e.prev AS prev, e.at AS at ORDER BY e.seq DESC LIMIT $limit`,
  ),
  erasures: q('desk.erasures', 'Certificates of erasure issued in this graph.', `MATCH (e:Erasure {status:'complete'}) RETURN e.id AS id, e.at AS at, e.certificate AS certificate ORDER BY e.at DESC`),
} as const;

export interface ChainLink {
  from: string;
  to: string;
  account: string;
  value: number;
  at: number;
  madeBy: string;
  standing: Standing;
}

export async function decisionView(db: Db, id: string, now: number) {
  const [d] = await db.ro<Record<string, unknown> & { standing: Standing }>(VIEW_QUERIES.decision, { id, now });
  if (!d) return null;
  const chain = await db.ro<ChainLink>(VIEW_QUERIES.citations, { id, now });
  const ids = [id, ...chain.map((c) => c.to)];
  const reversals = await db.ro(VIEW_QUERIES.overturnedBy, { ids });
  const sources = await db.ro(VIEW_QUERIES.sources, { id });
  return { decision: d, chain, reversals, sources };
}
