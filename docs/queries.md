# Every Cypher query Stare runs

Generated from the query catalogs in the source (`pnpm docs`). The model never writes Cypher: each query below is fixed, named, parameterised, and shown by name in the "Cypher that ran" panel of every decision. `stare.*` functions are the FalkorDB UDF library in `packages/core/src/udf/stare.js`; `flex.*` is FalkorDB FLEX; `algo.*` are FalkorDB built-in algorithms.

## Decision engine

How a request becomes approved, countered, escalated, denied or refused.

### `engine.resolveAccount` (read)

Resolve a free-text account name against the graph: exact, else FLEX Jaro-Winkler on the whole name AND token by token (a typo matches; an extra word like "GmbH" or "Europe" names a different company). No match means "not in the graph".

```cypher
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
ORDER BY score DESC LIMIT 3
```

### `engine.contactsOf` (read)

Contacts of an account (to link a request to the person who asked, for erasure later).

```cypher
MATCH (k:Contact)-[:CONTACT_OF]->(:Account {id:$accountId}) RETURN k.id AS id, k.name AS name
```

### `engine.policyNow` (read)

The policy version in force now, and which of its clauses the request violates (stare.violations, in-database).

```cypher
MATCH (p:Policy {id:$policyId})<-[:VERSION_OF]-(pv:PolicyVersion)
WHERE pv.effectiveFrom <= $now AND $now < pv.effectiveTo
OPTIONAL MATCH (pv)-[:HAS_CLAUSE]->(c:Clause)
WITH p, pv, collect({id: c.id, key: c.key, kind: c.kind, text: c.text}) AS clauses
RETURN p.id AS policyId, p.name AS policyName, p.unit AS unit, pv.id AS versionId, pv.version AS version,
       stare.violations($facts, pv) AS violations, clauses
ORDER BY pv.effectiveFrom DESC LIMIT 1
```

### `engine.delegation` (read)

The agent's live delegations for this policy, whether each delegator still holds the authority delegated, and excluding delegators who own the account (separation of duties).

```cypher
MATCH (ag:Agent {id:$agentId})<-[d:DELEGATES]-(p:Person)
WHERE d.policyId = $policyId AND d.validFrom <= $now AND $now < d.validTo AND p.leftAt > $now
OPTIONAL MATCH (p)-[h:HOLDS]->(:Role)-[g:MAY_APPROVE]->(:Policy {id:$policyId})
WHERE h.validFrom <= $now AND $now < h.validTo AND g.validFrom <= $now AND $now < g.validTo
WITH p, d, max(g.cap) AS authority
OPTIONAL MATCH (p)-[ow:OWNS]->(:Account {id:$accountId})
WHERE ow.validFrom <= $now AND $now < ow.validTo
WITH p, d, authority, count(ow) AS owned
WHERE owned = 0
RETURN p.id AS personId, p.name AS name, d.cap AS delegated, coalesce(authority, 0) AS authority
```

### `engine.standingRule` (read)

A ratified standing rule that covers the request and is not quarantined (stare.ruleStatus re-checks its basis).

```cypher
MATCH (s:StandingRule {policyId:$policyId, reasonCode:$reason})
WHERE $tier IN s.tiers AND s.maxValue >= $value
WITH s, stare.ruleStatus(s, $now) AS status
WHERE status = 'ratified'
RETURN s.id AS id, s.text AS text, s.maxValue AS maxValue
ORDER BY s.maxValue ASC LIMIT 1
```

### `engine.vectorSeeds` (read)

Vector search over past decisions: starting points only, never a basis on their own.

```cypher
CALL db.idx.vector.queryNodes('Decision', 'embedding', $k, vecf32($vec)) YIELD node, score
WITH node, score WHERE node.policyId = $policyId AND node.at < $now
RETURN node.id AS id, score
```

### `engine.structuralCandidates` (read)

Structural match: granted exceptions under the same policy for the same reason.

```cypher
MATCH (d:Decision:Exception)-[:BECAUSE]->(:Reason {code:$reason})
WHERE d.policyId = $policyId AND d.outcome IN ['approved', 'counter'] AND d.at < $now
RETURN d.id AS id
```

### `engine.evaluateCandidates` (read)

For each candidate precedent: does it cover the request (stare.covers) and is it still good law (stare.standing)?

```cypher
MATCH (d:Decision) WHERE d.id IN $ids
OPTIONAL MATCH (d)-[:ABOUT]->(a:Account)
OPTIONAL MATCH (d)-[:MADE_BY]->(m)
RETURN d.id AS id, d.value AS value, d.at AS at, d.facts AS facts, d.outcome AS outcome, d.basis AS basis, a.name AS account,
       m.name AS madeBy, labels(m)[0] AS makerKind, stare.covers(d, $facts) AS cover, stare.standing(d, $now) AS standing
```

### `engine.budget` (read)

This quarter's autonomy budget for the policy.

```cypher
MATCH (b:Budget {policyId:$policyId}) WHERE b.from <= $now AND $now < b.to
RETURN b.id AS id, b.unit AS unit, b.cap AS cap, b.remaining AS remaining, b.version AS version LIMIT 1
```

### `engine.approvers` (read)

People who hold authority over the policy right now, up to the value, excluding the account owner (separation of duties).

```cypher
MATCH (cand:Person)-[h:HOLDS]->(:Role)-[g:MAY_APPROVE]->(:Policy {id:$policyId})
WHERE h.validFrom <= $now AND $now < h.validTo AND g.validFrom <= $now AND $now < g.validTo
  AND g.cap >= $value AND cand.leftAt > $now AND NOT cand.id IN $exclude
WITH cand, max(g.cap) AS cap
OPTIONAL MATCH (cand)-[ow:OWNS]->(:Account {id:$accountId})
WHERE ow.validFrom <= $now AND $now < ow.validTo
WITH cand, cap, count(ow) AS owned
WHERE owned = 0
RETURN cand.id AS id, cand.name AS name, cap
ORDER BY cap ASC
```

### `engine.routes` (read)

Shortest reporting path (algo.SPpaths over live REPORTS_TO edges; ended edges carry cost 1 and maxCost 0 excludes them).

```cypher
MATCH (src:Person) WHERE src.id IN $sources
MATCH (cand:Person) WHERE cand.id IN $cands AND NOT cand.id IN $sources
CALL algo.SPpaths({sourceNode: src, targetNode: cand, relTypes: ['REPORTS_TO'], weightProp: 'w', costProp: 'dead', maxCost: 0, relDirection: 'outgoing', pathCount: 1})
YIELD path, pathWeight
RETURN cand.id AS id, pathWeight AS hops, [n IN nodes(path) | n.id] AS pathIds, [n IN nodes(path) | n.name] AS pathNames
```

### `engine.subjectSalt` (read)

The requester's salt, used to commit to them in the ledger without recording who they are.

```cypher
MATCH (:Contact {id:$contactId})-[:SALTED_BY]->(s:Salt) RETURN s.value AS salt
```

### `engine.caseUpsert` (write)

Open the case, idempotently: the same key always maps to the same case.

```cypher
MERGE (c:Case {key:$key})
ON CREATE SET c.id = $caseId, c.policyId = $policyId, c.accountId = $accountId, c.value = $value, c.days = $days,
  c.reason = $reason, c.tier = $tier, c.accountStatus = $accountStatus, c.text = $text, c.at = $now, c.status = 'open',
  c.filedBy = $filedBy, c.nonce = $nonce
WITH c
OPTIONAL MATCH (d:Decision)-[:DECIDES]->(c)
OPTIONAL MATCH (e:Escalation {status:'open'})-[:FOR]->(c)
RETURN c.id AS id, c.status AS status, c.nonce = $nonce AS created, d.id AS decisionId, e.id AS escalationId
```

### `engine.caseLinks` (write)

Link a new case to its account, reason, source message, filer and the contact who asked.

```cypher
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
RETURN c.id AS id
```

### `engine.commitDecision` (write)

Commit a terminal decision atomically: re-check budget, policy version, precedent standing, rule status, the live delegation, the delegator authority and independence inside the write; create the decision, spend the budget, append to the ledger. Any failed check writes nothing.

```cypher
MATCH (lh:LedgerHead {id:'head'})
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

WITH d, b, lh, stare.sha256(lh.hash + '|' + $ledgerPayloadHash) AS __nh
CREATE (le:LedgerEntry {seq: lh.seq + 1, kind: $ledgerKind, refId: $ledgerRefId, payload: $ledgerPayload,
                        payloadHash: $ledgerPayloadHash, prev: lh.hash, hash: __nh, at: $ledgerAt})
SET lh.seq = lh.seq + 1, lh.hash = __nh
SET d.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(d)
RETURN d.id AS id, le.seq AS seq, b.remaining AS remaining
```

### `engine.commitEscalation` (write)

Escalate: route the open case to the person the authority graph chose, and record the routing in the ledger.

```cypher
MATCH (lh:LedgerHead {id:'head'})
MATCH (c:Case {id:$caseId}) WHERE c.status = 'open'
MATCH (p:Person {id:$routeTo})
CREATE (e:Escalation {id:$escalationId, caseId:$caseId, status:'open', at:$now, pathIds:$pathIds, why:$why})-[:FOR]->(c)
CREATE (e)-[:ROUTED_TO]->(p)
SET c.status = 'escalated'

WITH e, lh, stare.sha256(lh.hash + '|' + $ledgerPayloadHash) AS __nh
CREATE (le:LedgerEntry {seq: lh.seq + 1, kind: $ledgerKind, refId: $ledgerRefId, payload: $ledgerPayload,
                        payloadHash: $ledgerPayloadHash, prev: lh.hash, hash: __nh, at: $ledgerAt})
SET lh.seq = lh.seq + 1, lh.hash = __nh
SET e.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(e)
RETURN e.id AS id, le.seq AS seq
```

### `engine.existingDecision` (read)

The decision already recorded for a case (idempotent replay).

```cypher
MATCH (d:Decision {caseId:$caseId})
OPTIONAL MATCH (d)-[:MADE_BY]->(m)
RETURN d.id AS id, d.outcome AS outcome, d.value AS value, d.requested AS requested, d.basis AS basis, d.ledgerSeq AS seq,
       d.narrative AS narrative, d.policyVersionId AS policyVersionId, m.id AS madeBy
```

### `engine.openEscalation` (read)

Open escalation for a case.

```cypher
MATCH (e:Escalation {status:'open'})-[:FOR]->(:Case {id:$caseId}) RETURN e.id AS id
```

### `engine.recordedCitations` (read)

The precedents a recorded decision cited.

```cypher
MATCH (:Decision {id:$id})-[:CITES]->(p:Decision) RETURN p.id AS id
```

### `engine.setNarrative` (write)

Store the gated explanation and its embedding on the decision.

```cypher
MATCH (d:Decision {id:$id}) SET d.narrative = $narrative, d.embedding = vecf32($vec) RETURN d.id AS id
```

## Human rulings

A person rules on an escalation; authority is re-checked inside the write.

### `approve.loadEscalation` (read)

An escalation with its case, account and the person it was routed to.

```cypher
MATCH (e:Escalation {id:$id})-[:FOR]->(c:Case)-[:FOR]->(a:Account)
OPTIONAL MATCH (e)-[:ROUTED_TO]->(p:Person)
RETURN e.status AS status, c.id AS caseId, c.policyId AS policyId, c.value AS value, c.days AS days, c.reason AS reason,
       c.text AS text, c.filedBy AS filedBy, a.id AS accountId, a.name AS account, p.id AS routedTo, p.name AS routedName
```

### `approve.authorityNow` (read)

What a person may approve right now under a policy, and whether they own the account (separation of duties).

```cypher
MATCH (p:Person {id:$personId})
OPTIONAL MATCH (p)-[h:HOLDS]->(:Role)-[g:MAY_APPROVE]->(:Policy {id:$policyId})
WHERE h.validFrom <= $now AND $now < h.validTo AND g.validFrom <= $now AND $now < g.validTo
WITH p, max(g.cap) AS cap
OPTIONAL MATCH (p)-[ow:OWNS]->(:Account {id:$accountId})
WHERE ow.validFrom <= $now AND $now < ow.validTo
RETURN p.name AS name, p.leftAt > $now AS active, coalesce(cap, 0) AS cap, count(ow) > 0 AS owns
```

### `approve.commitHumanDecision` (write)

Record a person's ruling on an escalation. Their authority, tenure and independence (not the account owner, not the filer) are re-checked inside the write; if any fails, nothing is written.

```cypher
MATCH (lh:LedgerHead {id:'head'})
MATCH (e:Escalation {id:$escalationId}) WHERE e.status = 'open'
MATCH (e)-[:FOR]->(c:Case) WHERE c.status <> 'decided' AND c.filedBy <> $personId
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
FOREACH (x IN precs | CREATE (x)-[:PRECEDENT_FOR {similarity: 1.0, at: $now}]->(d), (d)-[:CITES]->(x))
WITH lh, c, d
OPTIONAL MATCH (c)-[:FROM]->(s:Span)
WITH lh, d, collect(s) AS ss
FOREACH (x IN ss | CREATE (d)-[:GROUNDED_IN]->(x))

WITH d, lh, stare.sha256(lh.hash + '|' + $ledgerPayloadHash) AS __nh
CREATE (le:LedgerEntry {seq: lh.seq + 1, kind: $ledgerKind, refId: $ledgerRefId, payload: $ledgerPayload,
                        payloadHash: $ledgerPayloadHash, prev: lh.hash, hash: __nh, at: $ledgerAt})
SET lh.seq = lh.seq + 1, lh.hash = __nh
SET d.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(d)
RETURN d.id AS id, le.seq AS seq
```

## Standing rules

Procedural memory: good-law precedent becomes a ratified rule, quarantined when its basis falls.

### `rules.goodLawApprovals` (read)

Granted exceptions that are good law right now (candidates for a standing rule).

```cypher
MATCH (d:Decision:Exception)-[:BECAUSE]->(r:Reason)
WHERE d.outcome = 'approved' AND d.basis IN ['human', 'precedent']
WITH d, r, stare.standing(d, $now).flag AS flag
WHERE flag = 'green'
RETURN d.id AS id, d.policyId AS policyId, r.code AS reason, d.facts AS facts, d.value AS value, d.at AS at
```

### `rules.existing` (read)

Standing rules already proposed or ratified.

```cypher
MATCH (s:StandingRule) RETURN s.id AS id, s.policyId AS policyId, s.reasonCode AS reason, s.tiers AS tiers, s.status AS status
```

### `rules.propose` (write)

Propose a standing rule derived from good-law decisions of one shape.

```cypher
CREATE (s:StandingRule {id:$id, policyId:$policyId, reasonCode:$reason, tiers:$tiers, maxValue:$maxValue, status:'proposed',
                        createdAt:$now, ratifiedAt:0, text:$text})
WITH s UNWIND $basis AS bid
MATCH (d:Decision {id:bid}) CREATE (s)-[:DERIVED_FROM]->(d)
RETURN s.id AS id, count(d) AS basis
```

### `rules.ratify` (write)

Ratify a proposed rule. The ratifier's authority must cover the rule's ceiling now, and every basis decision must still be good law; checked inside the write.

```cypher
MATCH (lh:LedgerHead {id:'head'})
MATCH (s:StandingRule {id:$ruleId}) WHERE s.status = 'proposed' AND stare.ruleStatus(s, $now) = 'proposed'
MATCH (p:Person {id:$personId}) WHERE p.leftAt > $now
OPTIONAL MATCH (p)-[h:HOLDS]->(:Role)-[g:MAY_APPROVE]->(:Policy {id:s.policyId})
WHERE h.validFrom <= $now AND $now < h.validTo AND g.validFrom <= $now AND $now < g.validTo
WITH lh, s, p, max(g.cap) AS cap
WHERE cap >= s.maxValue
SET s.status = 'ratified', s.ratifiedAt = $now
CREATE (s)-[:RATIFIED_BY {at:$now}]->(p)

WITH s, lh, stare.sha256(lh.hash + '|' + $ledgerPayloadHash) AS __nh
CREATE (le:LedgerEntry {seq: lh.seq + 1, kind: $ledgerKind, refId: $ledgerRefId, payload: $ledgerPayload,
                        payloadHash: $ledgerPayloadHash, prev: lh.hash, hash: __nh, at: $ledgerAt})
SET lh.seq = lh.seq + 1, lh.hash = __nh
SET s.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(s)
RETURN s.id AS id, le.seq AS seq
```

### `rules.quarantine` (write)

Quarantine every rule whose basis is no longer good law (stare.ruleStatus).

```cypher
MATCH (s:StandingRule) WHERE s.status <> 'quarantined'
WITH s, stare.ruleStatus(s, $now) AS st
WHERE st = 'quarantined'
SET s.status = 'quarantined', s.quarantinedAt = $now
RETURN s.id AS id
```

### `rules.list` (read)

Every standing rule with its live status, basis and ratifier (procedural memory).

```cypher
MATCH (s:StandingRule)
OPTIONAL MATCH (s)-[:RATIFIED_BY]->(p:Person)
OPTIONAL MATCH (s)-[:DERIVED_FROM]->(d:Decision)-[:ABOUT]->(a:Account)
WITH s, p, collect({id: d.id, account: a.name, at: d.at, value: d.value}) AS basis
RETURN s.id AS id, s.policyId AS policyId, s.reasonCode AS reason, s.tiers AS tiers, s.maxValue AS maxValue, s.text AS text,
       s.status AS stored, stare.ruleStatus(s, $now) AS status, s.createdAt AS createdAt, s.ratifiedAt AS ratifiedAt,
       p.name AS ratifiedBy, basis
ORDER BY s.createdAt
```

## Knowledge currency

Policy changes, departures and reversals, and their effect on precedent.

### `impact.flags` (read)

Good-law flag of every decision at a point in time (one shared memo, in-database).

```cypher
MATCH (d:Decision) WITH collect(d) AS ds RETURN stare.standingMany(ds, $now) AS flags
```

### `impact.currentClauses` (read)

The clauses of the version in force, to start a draft from.

```cypher
MATCH (:Policy {id:$policyId})<-[:VERSION_OF]-(pv:PolicyVersion)
WHERE pv.effectiveFrom <= $now AND $now < pv.effectiveTo
MATCH (pv)-[:HAS_CLAUSE]->(c:Clause)
RETURN pv.id AS versionId, pv.version AS version, c.key AS key, c.kind AS kind, c.text AS text, c.rule AS rule ORDER BY c.key
```

### `impact.adoptPolicy` (write)

Adopt a new policy version: close the one in force, create the new one with its clauses, link SUPERSEDES, record it in the ledger.

```cypher
MATCH (lh:LedgerHead {id:'head'})
MATCH (p:Policy {id:$policyId})<-[:VERSION_OF]-(old:PolicyVersion)
WHERE old.effectiveFrom <= $now AND $now < old.effectiveTo
SET old.effectiveTo = $now
CREATE (nv:PolicyVersion {id:$versionId, policyId:$policyId, version:old.version + 1, effectiveFrom:$now, effectiveTo:$forever, text:$text})
CREATE (nv)-[:VERSION_OF]->(p), (nv)-[:SUPERSEDES]->(old)
WITH lh, nv
UNWIND $clauses AS c
CREATE (nv)-[:HAS_CLAUSE]->(:Clause {id:$versionId + '-' + c.key, key:c.key, kind:c.kind, text:c.text, rule:c.rule})
WITH lh, nv, count(*) AS n

WITH nv, lh, stare.sha256(lh.hash + '|' + $ledgerPayloadHash) AS __nh
CREATE (le:LedgerEntry {seq: lh.seq + 1, kind: $ledgerKind, refId: $ledgerRefId, payload: $ledgerPayload,
                        payloadHash: $ledgerPayloadHash, prev: lh.hash, hash: __nh, at: $ledgerAt})
SET lh.seq = lh.seq + 1, lh.hash = __nh
SET nv.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(nv)
RETURN nv.id AS id, nv.version AS version, le.seq AS seq
```

### `impact.replayCases` (read)

The most recent cases under a policy (the fixed replay set for autonomy).

```cypher
MATCH (c:Case {policyId:$policyId})-[:FOR]->(a:Account)
WHERE c.text IS NOT NULL AND c.text <> '' AND c.value IS NOT NULL
RETURN c.id AS id, a.name AS account, c.value AS value, c.days AS days, c.reason AS reason, c.at AS at
ORDER BY c.at DESC LIMIT $limit
```

### `impact.ruleStatus` (read)

Live status of every standing rule (stare.ruleStatus).

```cypher
MATCH (s:StandingRule) RETURN s.id AS id, s.text AS text, stare.ruleStatus(s, $now) AS status
```

### `impact.departPerson` (write)

Someone leaves: close their roles, ownerships, delegations and reporting lines. Their past decisions are untouched (authority is judged at the time).

```cypher
MATCH (lh:LedgerHead {id:'head'})
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

WITH p, lh, stare.sha256(lh.hash + '|' + $ledgerPayloadHash) AS __nh
CREATE (le:LedgerEntry {seq: lh.seq + 1, kind: $ledgerKind, refId: $ledgerRefId, payload: $ledgerPayload,
                        payloadHash: $ledgerPayloadHash, prev: lh.hash, hash: __nh, at: $ledgerAt})
SET lh.seq = lh.seq + 1, lh.hash = __nh
CREATE (le)-[:RECORDS]->(p)
RETURN p.id AS id, le.seq AS seq
```

### `impact.overturn` (write)

Overturn a decision: a reversal decision with an OVERTURNS edge. Everything that cites it becomes Overruling Risk at once.

```cypher
MATCH (lh:LedgerHead {id:'head'})
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

WITH r, lh, stare.sha256(lh.hash + '|' + $ledgerPayloadHash) AS __nh
CREATE (le:LedgerEntry {seq: lh.seq + 1, kind: $ledgerKind, refId: $ledgerRefId, payload: $ledgerPayload,
                        payloadHash: $ledgerPayloadHash, prev: lh.hash, hash: __nh, at: $ledgerAt})
SET lh.seq = lh.seq + 1, lh.hash = __nh
SET r.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(r)
RETURN r.id AS id, le.seq AS seq
```

### `impact.citedBy` (read)

Decisions that rely on a decision, directly or through a chain of citations.

```cypher
MATCH (x:Decision {id:$id})-[:PRECEDENT_FOR*1..6]->(d:Decision)
RETURN DISTINCT d.id AS id
```

## Forget with proof

Erasure cascade and the four certificate checks.

### `erasure.subject` (read)

The data subject, their salt and their account.

```cypher
MATCH (k:Contact {id:$contactId})
OPTIONAL MATCH (k)-[:SALTED_BY]->(s:Salt)
OPTIONAL MATCH (k)-[:CONTACT_OF]->(a:Account)
RETURN k.name AS name, k.email AS email, k.phone AS phone, s.value AS salt, a.name AS account
```

### `erasure.scanTerms` (read)

Every node and edge property, across every label and relationship type, that still contains an identifier (stare.scanTerms).

```cypher
CALL db.labels() YIELD label
WITH collect(label) AS ls
CALL db.relationshipTypes() YIELD relationshipType
WITH ls, collect(relationshipType) AS rs
RETURN stare.scanTerms($terms, ls, rs) AS hits
```

### `erasure.affectedSpans` (read)

Messages that mention the subject, by edge or by text.

```cypher
MATCH (s:Span)
OPTIONAL MATCH (s)-[m:MENTIONS]->(:Contact {id:$contactId})
WITH s, count(m) AS mentions
WHERE mentions > 0 OR any(t IN $terms WHERE toLower(s.text) CONTAINS toLower(t))
RETURN s.id AS id, s.embedding AS embedding
```

### `erasure.factSupport` (read)

Facts derived from the affected messages, and how much independent support each has left.

```cypher
MATCH (f:Fact)-[:DERIVED_FROM]->(s:Span) WHERE s.id IN $spanIds
WITH DISTINCT f
OPTIONAL MATCH (f)-[:DERIVED_FROM]->(o:Span) WHERE NOT o.id IN $spanIds
WITH f, collect(o.id) AS support
RETURN f.id AS id, f.text AS text, f.embedding AS embedding, support
```

### `erasure.touched` (read)

Decisions, cases, episodes, facts and handoff notes grounded in the affected messages or naming the subject.

```cypher
MATCH (n) WHERE (n:Decision OR n:Case OR n:Episode OR n:Fact OR n:Handoff)
OPTIONAL MATCH (n)-[g:GROUNDED_IN|FROM]->(s:Span) WHERE s.id IN $spanIds
WITH n, count(g) AS grounded,
     CASE WHEN n:Decision THEN n.narrative WHEN n:Case THEN n.text WHEN n:Episode THEN n.summary WHEN n:Handoff THEN n.note ELSE n.text END AS txt
WHERE grounded > 0 OR any(t IN $terms WHERE toLower(coalesce(txt, '')) CONTAINS toLower(t))
RETURN n.id AS id, labels(n)[0] AS label, txt AS text, n.embedding AS embedding
```

### `erasure.open` (write)

Open the erasure record (the tombstone that decisions stay grounded in).

```cypher
CREATE (e:Erasure {id:$id, at:$now, status:'running', subjectCommitment:$commitment}) RETURN e.id AS id
```

### `erasure.deleteFacts` (write)

Delete facts left with no independent support.

```cypher
MATCH (f:Fact) WHERE f.id IN $ids DETACH DELETE f
```

### `erasure.rewrite` (write)

Rewrite redacted text and its embedding in place (structure, authority and citations are kept).

```cypher
UNWIND $rows AS r
MATCH (n {id:r.id}) WHERE n:Decision OR n:Case OR n:Episode OR n:Fact OR n:Handoff
FOREACH (x IN CASE WHEN n:Decision THEN [n] ELSE [] END | SET x.narrative = r.text)
FOREACH (x IN CASE WHEN n:Handoff THEN [n] ELSE [] END | SET x.note = r.text)
FOREACH (x IN CASE WHEN n:Case OR n:Fact THEN [n] ELSE [] END | SET x.text = r.text)
FOREACH (x IN CASE WHEN n:Episode THEN [n] ELSE [] END | SET x.summary = r.text)
FOREACH (x IN CASE WHEN r.vec IS NULL THEN [] ELSE [n] END | SET x.embedding = vecf32(r.vec))
RETURN count(n) AS n
```

### `erasure.reground` (write)

Decisions grounded in erased messages are re-grounded in the erasure record.

```cypher
MATCH (e:Erasure {id:$erasureId})
MATCH (d:Decision)-[g:GROUNDED_IN]->(s:Span) WHERE s.id IN $spanIds
DELETE g
MERGE (d)-[:GROUNDED_IN]->(e)
RETURN count(DISTINCT d) AS n
```

### `erasure.deleteSpans` (write)

Delete the affected messages, then any source left empty.

```cypher
MATCH (s:Span) WHERE s.id IN $spanIds
OPTIONAL MATCH (s)-[:IN]->(src:Source)
DETACH DELETE s
WITH DISTINCT src WHERE src IS NOT NULL
OPTIONAL MATCH (rest:Span)-[:IN]->(src)
WITH src, count(rest) AS left WHERE left = 0
DETACH DELETE src
RETURN count(src) AS sources
```

### `erasure.shred` (write)

Delete the subject and their salt. Ledger entries keep their commitments, which can no longer be linked to anyone.

```cypher
MATCH (k:Contact {id:$contactId})
OPTIONAL MATCH (k)-[:SALTED_BY]->(s:Salt)
DETACH DELETE k, s
RETURN 1 AS ok
```

### `erasure.namePartsLeft` (read)

Records that were about the subject and still contain their first or last name.

```cypher
MATCH (n) WHERE n.id IN $ids
WITH n, CASE WHEN n:Decision THEN n.narrative WHEN n:Case THEN n.text WHEN n:Episode THEN n.summary WHEN n:Handoff THEN n.note ELSE n.text END AS txt
WHERE any(p IN $parts WHERE toLower(coalesce(txt, '')) CONTAINS toLower(p))
RETURN n.id AS id, labels(n)[0] AS label
```

### `erasure.leftovers` (read)

Anything still keyed by the subject id.

```cypher
MATCH (n) WHERE n.id IN [$contactId, 'salt-' + $contactId] RETURN count(n) AS n
```

### `erasure.vectorProbe` (read)

Nearest stored vector to a vector that existed before erasure (cosine distance; 0 means it is still there).

```cypher
CALL db.idx.vector.queryNodes($label, 'embedding', 1, vecf32($vec)) YIELD node, score RETURN node.id AS id, score
```

### `erasure.close` (write)

Store the certificate and record it in the ledger.

```cypher
MATCH (lh:LedgerHead {id:'head'})
MATCH (e:Erasure {id:$erasureId})
SET e.status = 'complete', e.certificate = $certificate, e.certificateHash = $certificateHash

WITH e, lh, stare.sha256(lh.hash + '|' + $ledgerPayloadHash) AS __nh
CREATE (le:LedgerEntry {seq: lh.seq + 1, kind: $ledgerKind, refId: $ledgerRefId, payload: $ledgerPayload,
                        payloadHash: $ledgerPayloadHash, prev: lh.hash, hash: __nh, at: $ledgerAt})
SET lh.seq = lh.seq + 1, lh.hash = __nh
SET e.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(e)
RETURN le.seq AS seq
```

## Graph algorithms as tools

PageRank, betweenness, label propagation and WCC over the decision graph.

### `algo.leadingCases` (read)

Leading cases: PageRank over CITES (citations point at the precedent, so authority flows to the decisions the company leans on most), each with its live good-law flag.

```cypher
CALL algo.pageRank('Decision', 'CITES') YIELD node, score
WITH node, score ORDER BY score DESC LIMIT $k
OPTIONAL MATCH (node)-[:ABOUT]->(a:Account)
OPTIONAL MATCH (node)-[:MADE_BY]->(m)
OPTIONAL MATCH (node)-[f:PRECEDENT_FOR]->(:Decision)
WITH node, score, a, m, count(f) AS followers
RETURN node.id AS id, a.name AS account, node.policyId AS policyId, node.value AS value, node.at AS at, m.name AS madeBy,
       score, followers, stare.standing(node, $now) AS standing
ORDER BY score DESC
```

### `algo.approvalBottlenecks` (read)

Approval bottlenecks: betweenness centrality on the reporting graph, with the escalations waiting on each person.

```cypher
CALL algo.betweenness({nodeLabels: ['Person'], relationshipTypes: ['REPORTS_TO']}) YIELD node, score
WITH node, score WHERE node.leftAt > $now
OPTIONAL MATCH (e:Escalation {status:'open'})-[:ROUTED_TO]->(node)
WITH node, score, count(e) AS waiting
RETURN node.id AS id, node.name AS name, node.title AS title, score, waiting
ORDER BY score DESC, waiting DESC LIMIT $k
```

### `algo.exceptionClusters` (read)

Exception clusters: label propagation over decisions, their reasons and citations.

```cypher
CALL algo.labelPropagation({nodeLabels: ['Decision', 'Reason'], relationshipTypes: ['BECAUSE', 'PRECEDENT_FOR']}) YIELD node, communityId
WITH node, communityId WHERE node:Decision AND node.outcome <> 'denied'
RETURN communityId, node.id AS id, node.policyId AS policyId, node.facts AS facts, node.value AS value, node.basis AS basis,
       stare.standing(node, $now).flag AS flag
```

### `algo.precedentFamilies` (read)

Precedent families: weakly connected components of the citation graph.

```cypher
CALL algo.WCC({nodeLabels: ['Decision'], relationshipTypes: ['PRECEDENT_FOR']}) YIELD node, componentId
WITH componentId, count(node) AS size WHERE size > 1
RETURN componentId, size ORDER BY size DESC LIMIT $k
```

## Agent memory

Episodic and semantic memory, handoffs.

### `memory.episodes` (read)

Episodic memory: past sessions of any agent, nearest to the question (shared across agents, private to the tenant).

```cypher
CALL db.idx.vector.queryNodes('Episode', 'embedding', $k, vecf32($vec)) YIELD node, score
MATCH (a:Agent)-[:HAD]->(node)
RETURN 'episode' AS kind, node.id AS id, node.summary AS text, node.at AS at, a.id AS agent, 1 - score AS similarity
```

### `memory.facts` (read)

Semantic memory: facts nearest to the question, each with the messages it was derived from.

```cypher
CALL db.idx.vector.queryNodes('Fact', 'embedding', $k, vecf32($vec)) YIELD node, score
OPTIONAL MATCH (node)-[:DERIVED_FROM]->(s:Span)-[:IN]->(src:Source)
RETURN 'fact' AS kind, node.id AS id, node.text AS text, node.at AS at, 1 - score AS similarity,
       collect(DISTINCT src.channel + ' · ' + src.title) AS sources
```

### `memory.aboutAccount` (read)

Graph expansion: everything remembered about one account (facts, episodes, open handoffs), regardless of wording.

```cypher
MATCH (a:Account) WHERE toLower(a.name) = toLower($account)
OPTIONAL MATCH (f:Fact)-[:ABOUT]->(a)
OPTIONAL MATCH (e:Episode)-[:ABOUT]->(a)
OPTIONAL MATCH (ag:Agent)-[:HAD]->(e)
WITH a, collect(DISTINCT {kind:'fact', id:f.id, text:f.text, at:f.at}) AS facts,
        collect(DISTINCT {kind:'episode', id:e.id, text:e.summary, at:e.at, agent:ag.id}) AS episodes
RETURN a.id AS accountId, facts, episodes
```

### `memory.lastEpisode` (read)

An agent's most recent episode (where its next session picks up).

```cypher
MATCH (:Agent {id:$agentId})-[:HAD]->(e:Episode) RETURN e.id AS id, e.summary AS summary, e.at AS at, e.sessionId AS sessionId ORDER BY e.at DESC LIMIT 1
```

### `memory.remember` (write)

Write an episode: link it to the agent, to the previous episode, and to what it was about.

```cypher
MATCH (a:Agent {id:$agentId})
OPTIONAL MATCH (a)-[:HAD]->(prev:Episode) WHERE NOT (prev)-[:NEXT]->(:Episode)
CREATE (a)-[:HAD]->(e:Episode {id:$id, agentId:$agentId, sessionId:$sessionId, at:$now, summary:$summary, embedding:vecf32($vec)})
FOREACH (p IN CASE WHEN prev IS NULL THEN [] ELSE [prev] END | CREATE (p)-[:NEXT]->(e))
WITH e
UNWIND (CASE WHEN size($about) = 0 THEN [null] ELSE $about END) AS x
OPTIONAL MATCH (n {id:x}) WHERE n:Account OR n:Case OR n:Decision
FOREACH (m IN CASE WHEN n IS NULL THEN [] ELSE [n] END | CREATE (e)-[:ABOUT]->(m))
RETURN DISTINCT e.id AS id
```

### `memory.handoff` (write)

Hand a case to another agent, with a note that travels with it.

```cypher
MATCH (f:Agent {id:$from}), (t:Agent {id:$to})
CREATE (f)-[:HANDED_OFF]->(h:Handoff {id:$id, caseId:$caseId, note:$note, at:$now, status:'open'})-[:TO]->(t)
WITH h
OPTIONAL MATCH (c:Case {id:$caseId})
FOREACH (x IN CASE WHEN c IS NULL THEN [] ELSE [c] END | CREATE (h)-[:FOR]->(x))
RETURN h.id AS id
```

### `memory.handoffInbox` (read)

Open handoffs waiting for an agent.

```cypher
MATCH (f:Agent)-[:HANDED_OFF]->(h:Handoff {status:'open'})-[:TO]->(:Agent {id:$agentId})
RETURN h.id AS id, f.id AS from, h.caseId AS caseId, h.note AS note, h.at AS at ORDER BY h.at
```

### `memory.acceptHandoff` (write)

Accept a handoff.

```cypher
MATCH (h:Handoff {id:$id})-[:TO]->(:Agent {id:$agentId}) WHERE h.status = 'open' SET h.status = 'accepted', h.acceptedAt = $now RETURN h.id AS id
```

## Concurrency

The 64-request burst and its invariants.

### `race.accounts` (read)

Active accounts by tier (to build the burst).

```cypher
MATCH (a:Account {status:'active'}) RETURN a.name AS name, a.tier AS tier ORDER BY a.name
```

### `race.budgets` (read)

Autonomy budgets in force.

```cypher
MATCH (b:Budget) WHERE b.from <= $now AND $now < b.to RETURN b.id AS id, b.policyId AS policyId, b.unit AS unit, b.cap AS cap, b.remaining AS remaining
```

### `race.terminalPerCase` (read)

Invariant: every case in the burst has exactly one outcome (one decision, or one open escalation), never two.

```cypher
MATCH (c:Case) WHERE c.key STARTS WITH $prefix
OPTIONAL MATCH (d:Decision)-[:DECIDES]->(c)
OPTIONAL MATCH (e:Escalation)-[:FOR]->(c)
WITH c, count(DISTINCT d) AS decisions, count(DISTINCT e) AS escalations
RETURN count(c) AS cases, sum(CASE WHEN decisions + escalations = 1 THEN 1 ELSE 0 END) AS exactlyOne,
       sum(CASE WHEN decisions > 1 THEN 1 ELSE 0 END) AS doubleDecided
```

### `race.spent` (read)

What the agents actually granted from the autonomy budget during the burst.

```cypher
MATCH (d:Decision)-[:DECIDES]->(c:Case) WHERE c.key STARTS WITH $prefix AND d.basis IN ['precedent', 'rule'] AND d.outcome <> 'denied'
RETURN d.policyId AS policyId, sum(d.value) AS value, count(d) AS n
```

## Ledger

The hash chain (hashes computed in-database with stare.sha256).

### `ledger.init` (write)

Create the ledger head (genesis) if the graph has none.

```cypher
MERGE (lh:LedgerHead {id:'head'}) ON CREATE SET lh.seq = 0, lh.hash = 'GENESIS' RETURN lh.seq AS seq
```

### `ledger.append` (write)

Append one entry to the hash chain (hash computed in-database with stare.sha256).

```cypher
MATCH (lh:LedgerHead {id:'head'})
WITH lh, stare.sha256(lh.hash + '|' + $ledgerPayloadHash) AS __nh
CREATE (le:LedgerEntry {seq: lh.seq + 1, kind: $ledgerKind, refId: $ledgerRefId, payload: $ledgerPayload,
                        payloadHash: $ledgerPayloadHash, prev: lh.hash, hash: __nh, at: $ledgerAt})
SET lh.seq = lh.seq + 1, lh.hash = __nh
RETURN le.seq AS seq, le.hash AS hash
```

### `ledger.entries` (read)

Every ledger entry in sequence order, plus the head.

```cypher
MATCH (e:LedgerEntry)
WITH e ORDER BY e.seq
WITH collect({seq: e.seq, kind: e.kind, refId: e.refId, payload: e.payload, payloadHash: e.payloadHash, prev: e.prev, hash: e.hash}) AS entries
OPTIONAL MATCH (lh:LedgerHead {id:'head'})
RETURN entries, lh.seq AS headSeq, lh.hash AS headHash
```

### `ledger.decisions` (read)

Every decision with the fields the ledger committed to (for the deep check).

```cypher
MATCH (d:Decision)
OPTIONAL MATCH (d)-[:MADE_BY]->(m)
RETURN d.id AS id, d.caseId AS caseId, d.outcome AS outcome, d.value AS value, d.basis AS basis,
       d.policyVersionId AS policyVersionId, m.id AS madeBy, d.at AS at
```

## Desk read models

What the web console shows.

### `desk.overview` (read)

Headline numbers for the desk: decisions by flag, open escalations, autonomy budgets, ledger head.

```cypher
MATCH (d:Decision) WITH collect(d) AS ds
WITH ds, stare.standingMany(ds, $now) AS flags
OPTIONAL MATCH (e:Escalation {status:'open'})
WITH ds, flags, count(e) AS open
OPTIONAL MATCH (lh:LedgerHead {id:'head'})
RETURN size(ds) AS decisions, size([f IN flags WHERE f.flag = 'green']) AS green, size([f IN flags WHERE f.flag = 'yellow']) AS yellow,
       size([f IN flags WHERE f.flag = 'red']) AS red, open, lh.seq AS ledgerSeq, lh.hash AS ledgerHead
```

### `desk.budgets` (read)

Autonomy budgets in force.

```cypher
MATCH (b:Budget) WHERE b.from <= $now AND $now < b.to RETURN b.id AS id, b.policyId AS policyId, b.unit AS unit, b.cap AS cap, b.remaining AS remaining ORDER BY b.policyId
```

### `desk.agents` (read)

Each agent, its live delegations and its last episode.

```cypher
MATCH (a:Agent)
OPTIONAL MATCH (p:Person)-[d:DELEGATES]->(a) WHERE d.validFrom <= $now AND $now < d.validTo AND p.leftAt > $now
WITH a, collect({person: p.name, personId: p.id, cap: d.cap, policyId: d.policyId}) AS delegations
OPTIONAL MATCH (a)-[:HAD]->(e:Episode)
WITH a, delegations, e ORDER BY e.at DESC
WITH a, delegations, collect(e)[0] AS last
RETURN a.id AS id, a.name AS name, a.kind AS kind, a.policyId AS policyId, delegations, last.summary AS lastEpisode, last.at AS lastAt
```

### `desk.cases` (read)

Most recent cases with their outcome.

```cypher
MATCH (c:Case)-[:FOR]->(a:Account)
WITH c, a ORDER BY c.at DESC LIMIT $limit
OPTIONAL MATCH (d:Decision)-[:DECIDES]->(c)
OPTIONAL MATCH (e:Escalation)-[:FOR]->(c)
OPTIONAL MATCH (e)-[:ROUTED_TO]->(p:Person)
RETURN c.id AS id, c.at AS at, c.policyId AS policyId, c.value AS value, c.reason AS reason, c.text AS text, c.status AS status, c.filedBy AS filedBy,
       a.name AS account, d.id AS decisionId, d.outcome AS outcome, d.value AS granted, d.basis AS basis, e.id AS escalationId, e.status AS escalationStatus, p.name AS routedTo
ORDER BY c.at DESC
```

### `desk.decision` (read)

One decision with its maker, authority, policy version, account and live standing.

```cypher
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
       le.seq AS ledgerSeq, le.hash AS ledgerHash, stare.standing(d, $now) AS standing
```

### `desk.citationChain` (read)

The precedent chain behind a decision (CITES, up to four hops), each link with its live flag.

```cypher
MATCH p = (:Decision {id:$id})-[:CITES*1..4]->(:Decision)
UNWIND relationships(p) AS r
WITH DISTINCT startNode(r) AS a, endNode(r) AS b
OPTIONAL MATCH (b)-[:ABOUT]->(acc:Account)
OPTIONAL MATCH (b)-[:MADE_BY]->(m)
RETURN a.id AS from, b.id AS to, acc.name AS account, b.value AS value, b.at AS at, m.name AS madeBy, stare.standing(b, $now) AS standing
```

### `desk.overturnedBy` (read)

Reversals affecting a decision or anything in its chain.

```cypher
MATCH (r:Decision)-[o:OVERTURNS]->(x:Decision) WHERE x.id IN $ids
OPTIONAL MATCH (r)-[:MADE_BY]->(p:Person)
RETURN x.id AS target, r.id AS by, p.name AS person, o.reason AS reason, o.at AS at
```

### `desk.sources` (read)

The messages a decision is grounded in (and erasure tombstones).

```cypher
MATCH (d:Decision {id:$id})-[:GROUNDED_IN]->(g)
OPTIONAL MATCH (g)-[:IN]->(src:Source)
RETURN labels(g)[0] AS kind, g.id AS id, g.text AS text, g.at AS at, g.author AS author, src.channel AS channel, src.title AS title, g.certificateHash AS certificateHash
ORDER BY g.at
```

### `desk.inbox` (read)

Open escalations, with who they are routed to and why.

```cypher
MATCH (e:Escalation {status:'open'})-[:FOR]->(c:Case)-[:FOR]->(a:Account)
OPTIONAL MATCH (e)-[:ROUTED_TO]->(p:Person)
RETURN e.id AS id, e.at AS at, e.why AS why, e.pathIds AS pathIds, c.id AS caseId, c.policyId AS policyId, c.value AS value, c.reason AS reason,
       c.text AS text, a.name AS account, p.id AS routedToId, p.name AS routedTo
ORDER BY e.at DESC
```

### `desk.people` (read)

People with their current roles and approval authority per policy.

```cypher
MATCH (p:Person)
OPTIONAL MATCH (p)-[h:HOLDS]->(r:Role) WHERE h.validFrom <= $now AND $now < h.validTo
OPTIONAL MATCH (r)-[g:MAY_APPROVE]->(pol:Policy) WHERE g.validFrom <= $now AND $now < g.validTo
WITH p, collect(DISTINCT r.name) AS roles, collect(DISTINCT {policy: pol.id, cap: g.cap}) AS caps
RETURN p.id AS id, p.name AS name, p.title AS title, p.leftAt > $now AS active, roles, [c IN caps WHERE c.policy IS NOT NULL] AS authority
ORDER BY p.name
```

### `desk.contacts` (read)

Customer contacts (data subjects) with how much of the graph mentions them.

```cypher
MATCH (k:Contact)-[:CONTACT_OF]->(a:Account)
OPTIONAL MATCH (s:Span)-[:MENTIONS]->(k)
WITH k, a, count(s) AS mentions
RETURN k.id AS id, k.name AS name, k.title AS title, a.name AS account, mentions
ORDER BY mentions DESC, k.name LIMIT $limit
```

### `desk.policies` (read)

Every policy version with its clauses.

```cypher
MATCH (p:Policy)<-[:VERSION_OF]-(v:PolicyVersion)
OPTIONAL MATCH (v)-[:HAS_CLAUSE]->(c:Clause)
WITH p, v, collect({key: c.key, kind: c.kind, text: c.text, rule: c.rule}) AS clauses
RETURN p.id AS policyId, p.name AS name, p.unit AS unit, v.id AS versionId, v.version AS version, v.effectiveFrom AS from, v.effectiveTo AS to,
       v.effectiveFrom <= $now AND $now < v.effectiveTo AS current, clauses
ORDER BY p.id, v.version
```

### `desk.ledgerTail` (read)

The most recent ledger entries.

```cypher
MATCH (e:LedgerEntry) RETURN e.seq AS seq, e.kind AS kind, e.refId AS refId, e.hash AS hash, e.prev AS prev, e.at AS at ORDER BY e.seq DESC LIMIT $limit
```

### `desk.erasures` (read)

Certificates of erasure issued in this graph.

```cypher
MATCH (e:Erasure {status:'complete'}) RETURN e.id AS id, e.at AS at, e.certificate AS certificate ORDER BY e.at DESC
```

