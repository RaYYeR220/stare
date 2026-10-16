import type { NamedQuery } from '../db.ts';
import { LEDGER_HEAD, ledgerWrite } from '../ledger.ts';

const q = (name: string, mode: 'ro' | 'rw', doc: string, cypher: string): NamedQuery => ({
  name,
  mode,
  doc,
  cypher: cypher.trim(),
});

/** Every query the decision engine runs. docs/queries.md is generated from this catalog. */
export const Q = {
  resolveAccount: q(
    'engine.resolveAccount',
    'ro',
    'Resolve a free-text account name against the graph: exact, else FLEX Jaro-Winkler on the whole name AND token by token (a typo matches; an extra word like "GmbH" or "Europe" names a different company). No match means "not in the graph".',
    `
MATCH (a:Account)
WITH a, toLower(a.name) AS n, toLower($name) AS q
WITH a, n, q, split(n, ' ') AS nt, split(q, ' ') AS qt
WITH a, CASE WHEN n = q THEN 1.0
             WHEN size(nt) <> size(qt) THEN 0.0
             WHEN all(i IN range(0, size(nt) - 1) WHERE flex.text.jaroWinkler(nt[i], qt[i]) >= 0.88) THEN flex.text.jaroWinkler(n, q)
             ELSE 0.0 END AS score
WHERE score >= $threshold
OPTIONAL MATCH (o:Person)-[ow:OWNS]->(a) WHERE ow.validFrom <= $now AND $now < ow.validTo
RETURN a.id AS id, a.name AS name, a.tier AS tier, a.status AS status, score, o.id AS ownerId, o.name AS ownerName
ORDER BY score DESC LIMIT 3`,
  ),

  contactsOf: q(
    'engine.contactsOf',
    'ro',
    'Contacts of an account (to link a request to the person who asked, for erasure later).',
    `MATCH (k:Contact)-[:CONTACT_OF]->(:Account {id:$accountId}) RETURN k.id AS id, k.name AS name`,
  ),

  policyNow: q(
    'engine.policyNow',
    'ro',
    'The policy version in force now, and which of its clauses the request violates (stare.violations, in-database).',
    `
MATCH (p:Policy {id:$policyId})<-[:VERSION_OF]-(pv:PolicyVersion)
WHERE pv.effectiveFrom <= $now AND $now < pv.effectiveTo
OPTIONAL MATCH (pv)-[:HAS_CLAUSE]->(c:Clause)
WITH p, pv, collect({id: c.id, key: c.key, kind: c.kind, text: c.text}) AS clauses
RETURN p.id AS policyId, p.name AS policyName, p.unit AS unit, pv.id AS versionId, pv.version AS version,
       stare.violations($facts, pv) AS violations, clauses
ORDER BY pv.effectiveFrom DESC LIMIT 1`,
  ),

  delegation: q(
    'engine.delegation',
    'ro',
    "The agent's live delegations for this policy, whether each delegator still holds the authority delegated, and excluding delegators who own the account (separation of duties).",
    `
MATCH (ag:Agent {id:$agentId})<-[d:DELEGATES]-(p:Person)
WHERE d.policyId = $policyId AND d.validFrom <= $now AND $now < d.validTo AND p.leftAt > $now
OPTIONAL MATCH (p)-[h:HOLDS]->(:Role)-[g:MAY_APPROVE]->(:Policy {id:$policyId})
WHERE h.validFrom <= $now AND $now < h.validTo AND g.validFrom <= $now AND $now < g.validTo
WITH p, d, max(g.cap) AS authority
OPTIONAL MATCH (p)-[ow:OWNS]->(:Account {id:$accountId})
WHERE ow.validFrom <= $now AND $now < ow.validTo
WITH p, d, authority, count(ow) AS owned
WHERE owned = 0
RETURN p.id AS personId, p.name AS name, d.cap AS delegated, coalesce(authority, 0) AS authority`,
  ),

  rule: q(
    'engine.standingRule',
    'ro',
    'A ratified standing rule that covers the request and is not quarantined (stare.ruleStatus re-checks its basis).',
    `
MATCH (s:StandingRule {policyId:$policyId, reasonCode:$reason})
WHERE $tier IN s.tiers AND s.maxValue >= $value
WITH s, stare.ruleStatus(s, $now) AS status
WHERE status = 'ratified'
RETURN s.id AS id, s.text AS text, s.maxValue AS maxValue
ORDER BY s.maxValue ASC LIMIT 1`,
  ),

  vectorSeeds: q(
    'engine.vectorSeeds',
    'ro',
    'Vector search over past decisions: starting points only, never a basis on their own.',
    `
CALL db.idx.vector.queryNodes('Decision', 'embedding', $k, vecf32($vec)) YIELD node, score
WITH node, score WHERE node.policyId = $policyId AND node.at < $now
RETURN node.id AS id, score`,
  ),

  structuralIds: q(
    'engine.structuralCandidates',
    'ro',
    'Structural match: granted exceptions under the same policy for the same reason.',
    `
MATCH (d:Decision:Exception)-[:BECAUSE]->(:Reason {code:$reason})
WHERE d.policyId = $policyId AND d.outcome IN ['approved', 'counter'] AND d.at < $now
RETURN d.id AS id`,
  ),

  evaluateCandidates: q(
    'engine.evaluateCandidates',
    'ro',
    'For each candidate precedent: does it cover the request (stare.covers) and is it still good law (stare.standing)?',
    `
MATCH (d:Decision) WHERE d.id IN $ids
OPTIONAL MATCH (d)-[:ABOUT]->(a:Account)
OPTIONAL MATCH (d)-[:MADE_BY]->(m)
RETURN d.id AS id, d.value AS value, d.at AS at, d.facts AS facts, d.outcome AS outcome, d.basis AS basis, a.name AS account,
       m.name AS madeBy, labels(m)[0] AS makerKind, stare.covers(d, $facts) AS cover, stare.standing(d, $now) AS standing`,
  ),

  budget: q(
    'engine.budget',
    'ro',
    "This quarter's autonomy budget for the policy.",
    `
MATCH (b:Budget {policyId:$policyId}) WHERE b.from <= $now AND $now < b.to
RETURN b.id AS id, b.unit AS unit, b.cap AS cap, b.remaining AS remaining, b.version AS version LIMIT 1`,
  ),

  approvers: q(
    'engine.approvers',
    'ro',
    'People who hold authority over the policy right now, up to the value, excluding the account owner (separation of duties).',
    `
MATCH (cand:Person)-[h:HOLDS]->(:Role)-[g:MAY_APPROVE]->(:Policy {id:$policyId})
WHERE h.validFrom <= $now AND $now < h.validTo AND g.validFrom <= $now AND $now < g.validTo
  AND g.cap >= $value AND cand.leftAt > $now AND NOT cand.id IN $exclude
WITH cand, max(g.cap) AS cap
OPTIONAL MATCH (cand)-[ow:OWNS]->(:Account {id:$accountId})
WHERE ow.validFrom <= $now AND $now < ow.validTo
WITH cand, cap, count(ow) AS owned
WHERE owned = 0
RETURN cand.id AS id, cand.name AS name, cap
ORDER BY cap ASC`,
  ),

  routes: q(
    'engine.routes',
    'ro',
    'Shortest reporting path (algo.SPpaths over live REPORTS_TO edges; ended edges carry cost 1 and maxCost 0 excludes them).',
    `
MATCH (src:Person) WHERE src.id IN $sources
MATCH (cand:Person) WHERE cand.id IN $cands AND NOT cand.id IN $sources
CALL algo.SPpaths({sourceNode: src, targetNode: cand, relTypes: ['REPORTS_TO'], weightProp: 'w', costProp: 'dead', maxCost: 0, relDirection: 'outgoing', pathCount: 1})
YIELD path, pathWeight
RETURN cand.id AS id, pathWeight AS hops, [n IN nodes(path) | n.id] AS pathIds, [n IN nodes(path) | n.name] AS pathNames`,
  ),

  salt: q(
    'engine.subjectSalt',
    'ro',
    "The requester's salt, used to commit to them in the ledger without recording who they are.",
    `MATCH (:Contact {id:$contactId})-[:SALTED_BY]->(s:Salt) RETURN s.value AS salt`,
  ),

  caseUpsert: q(
    'engine.caseUpsert',
    'rw',
    'Open the case, idempotently: the same key always maps to the same case.',
    `
MERGE (c:Case {key:$key})
ON CREATE SET c.id = $caseId, c.policyId = $policyId, c.accountId = $accountId, c.value = $value, c.days = $days,
  c.reason = $reason, c.tier = $tier, c.accountStatus = $accountStatus, c.text = $text, c.at = $now, c.status = 'open',
  c.filedBy = $filedBy, c.nonce = $nonce
WITH c
OPTIONAL MATCH (d:Decision)-[:DECIDES]->(c)
OPTIONAL MATCH (e:Escalation {status:'open'})-[:FOR]->(c)
RETURN c.id AS id, c.status AS status, c.nonce = $nonce AS created, d.id AS decisionId, e.id AS escalationId`,
  ),

  caseLinks: q(
    'engine.caseLinks',
    'rw',
    'Link a new case to its account, reason, source message, filer and the contact who asked.',
    `
MATCH (c:Case {id:$caseId}), (a:Account {id:$accountId})
MERGE (rs:Reason {code:$reason}) ON CREATE SET rs.id = 'reason-' + $reason
CREATE (c)-[:FOR]->(a), (c)-[:BECAUSE]->(rs)
CREATE (src:Source {id:$sourceId, kind:'message', title:$title, channel:$channel, at:$now})
CREATE (s:Span {id:$spanId, text:$text, at:$now, author:$filedBy, embedding:vecf32($vec)})-[:IN]->(src)
CREATE (c)-[:FROM]->(s), (s)-[:MENTIONS]->(a)
WITH c, s
OPTIONAL MATCH (f {id:$filedBy}) WHERE f:Person OR f:Agent
FOREACH (x IN CASE WHEN f IS NULL THEN [] ELSE [f] END | CREATE (c)-[:FILED_BY]->(x))
WITH c, s
OPTIONAL MATCH (k:Contact) WHERE k.id IN $contactIds
WITH c, s, collect(k) AS ks
FOREACH (k IN ks | CREATE (s)-[:MENTIONS]->(k), (c)-[:REQUESTED_BY]->(k))
RETURN c.id AS id`,
  ),

  commitDecision: q(
    'engine.commitDecision',
    'rw',
    'Commit a terminal decision atomically: re-check budget, policy version, precedent standing, rule status, the live delegation, the delegator authority and independence inside the write; create the decision, spend the budget, append to the ledger. Any failed check writes nothing.',
    `
${LEDGER_HEAD}
MATCH (c:Case {id:$caseId}) WHERE c.status <> 'decided'
MATCH (pv:PolicyVersion {id:$pvId}) WHERE pv.effectiveFrom <= $now AND $now < pv.effectiveTo
MATCH (maker {id:$makerId}) WHERE maker:Agent OR maker:Person
MATCH (a:Account {id:$accountId})
MATCH (rs:Reason {code:$reason})
OPTIONAL MATCH (b:Budget {id:$budgetId})
WITH lh, c, pv, maker, a, rs, b
WHERE $cost = 0 OR (b IS NOT NULL AND b.remaining >= $cost)
OPTIONAL MATCH (p:Decision) WHERE p.id IN $citeIds
WITH lh, c, pv, maker, a, rs, b, collect(p) AS precs
WHERE size(precs) = size($citeIds) AND all(x IN precs WHERE stare.standing(x, $now).flag = 'green')
OPTIONAL MATCH (rule:StandingRule {id:$ruleId})
WITH lh, c, pv, maker, a, rs, b, precs, rule
WHERE $ruleId = '' OR (rule IS NOT NULL AND stare.ruleStatus(rule, $now) = 'ratified')
WITH lh, c, pv, maker, a, rs, b, precs, rule
WHERE NOT maker:Agent OR $authId <> '' OR $outcome = 'denied'
OPTIONAL MATCH (auth:Person {id:$authId})-[dl:DELEGATES]->(maker)
WHERE dl.policyId = $policyId AND dl.validFrom <= $now AND $now < dl.validTo AND dl.cap >= $value AND auth.leftAt > $now
WITH lh, c, pv, maker, a, rs, b, precs, rule, auth, count(dl) AS delegations
WHERE $authId = '' OR delegations > 0
OPTIONAL MATCH (auth)-[h:HOLDS]->(:Role)-[g:MAY_APPROVE]->(:Policy {id:$policyId})
WHERE h.validFrom <= $now AND $now < h.validTo AND g.validFrom <= $now AND $now < g.validTo
WITH lh, c, pv, maker, a, rs, b, precs, rule, auth, max(g.cap) AS authCap
WHERE $authId = '' OR NOT $exception OR authCap >= $value
OPTIONAL MATCH (auth)-[ow:OWNS]->(a) WHERE ow.validFrom <= $now AND $now < ow.validTo
WITH lh, c, pv, maker, a, rs, b, precs, rule, auth, count(ow) AS authOwns
WHERE $authId = '' OR authOwns = 0
CREATE (d:Decision {id:$decisionId, caseId:$caseId, outcome:$outcome, value:$value, requested:$requested, basis:$basis, at:$now,
                    policyId:$policyId, policyVersionId:$pvId, accountId:$accountId, facts:$facts, narrative:$narrative})
CREATE (d)-[:DECIDES]->(c), (d)-[:APPLIED_POLICY]->(pv), (d)-[:MADE_BY]->(maker), (d)-[:ABOUT]->(a), (d)-[:BECAUSE]->(rs)
SET c.status = 'decided'
FOREACH (x IN CASE WHEN $exception THEN [d] ELSE [] END | SET x:Exception)
FOREACH (x IN CASE WHEN b IS NULL OR $cost = 0 THEN [] ELSE [b] END | SET x.remaining = x.remaining - $cost, x.version = x.version + 1)
FOREACH (p IN precs | CREATE (p)-[:PRECEDENT_FOR {similarity: coalesce(head([x IN $sims WHERE x.id = p.id | x.sim]), 0.0), at: $now}]->(d), (d)-[:CITES]->(p))
FOREACH (x IN CASE WHEN rule IS NULL THEN [] ELSE [rule] END | CREATE (d)-[:CITES_RULE]->(x))
FOREACH (x IN CASE WHEN auth IS NULL THEN [] ELSE [auth] END | CREATE (d)-[:ON_AUTHORITY_OF]->(x))
WITH lh, c, d, b
OPTIONAL MATCH (c)-[:FROM]->(s:Span)
WITH lh, d, b, collect(s) AS ss
FOREACH (x IN ss | CREATE (d)-[:GROUNDED_IN]->(x))
${ledgerWrite(['d', 'b'])}
SET d.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(d)
RETURN d.id AS id, le.seq AS seq, b.remaining AS remaining`,
  ),

  commitEscalation: q(
    'engine.commitEscalation',
    'rw',
    'Escalate: route the open case to the person the authority graph chose, and record the routing in the ledger.',
    `
${LEDGER_HEAD}
MATCH (c:Case {id:$caseId}) WHERE c.status = 'open'
MATCH (p:Person {id:$routeTo})
CREATE (e:Escalation {id:$escalationId, caseId:$caseId, status:'open', at:$now, pathIds:$pathIds, why:$why})-[:FOR]->(c)
CREATE (e)-[:ROUTED_TO]->(p)
SET c.status = 'escalated'
${ledgerWrite(['e'])}
SET e.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(e)
RETURN e.id AS id, le.seq AS seq`,
  ),

  existingDecision: q(
    'engine.existingDecision',
    'ro',
    'The decision already recorded for a case (idempotent replay).',
    `
MATCH (d:Decision {caseId:$caseId})
OPTIONAL MATCH (d)-[:MADE_BY]->(m)
RETURN d.id AS id, d.outcome AS outcome, d.value AS value, d.requested AS requested, d.basis AS basis, d.ledgerSeq AS seq,
       d.narrative AS narrative, d.policyVersionId AS policyVersionId, m.id AS madeBy`,
  ),

  setNarrative: q(
    'engine.setNarrative',
    'rw',
    'Store the gated explanation and its embedding on the decision.',
    `MATCH (d:Decision {id:$id}) SET d.narrative = $narrative, d.embedding = vecf32($vec) RETURN d.id AS id`,
  ),
} as const;
