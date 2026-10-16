// Stare UDF library for FalkorDB (QuickJS). Loaded once by the server with GRAPH.UDF LOAD.
// Everything that decides whether a precedent is still good law lives here, inside the database,
// so the engine, the policy simulator, the erasure certificate and the eval all share one answer.
//
// Call from Cypher as stare.<fn>(...). UDFs are read-only: they never modify the graph.

var FOREVER = 253402300799000;
var MAX_DEPTH = 12;
var TIER_RANK = { standard: 1, growth: 2, enterprise: 3 };

// ---------------------------------------------------------------- helpers

function attr(x, k, dflt) {
  var a = x && x.attributes;
  if (!a || a[k] === undefined || a[k] === null) return dflt;
  return a[k];
}

function validAt(edge, t) {
  var from = attr(edge, 'validFrom', 0);
  var to = attr(edge, 'validTo', FOREVER);
  return from <= t && t < to;
}

function out(node, type) {
  return node.getNeighbors({ direction: 'outgoing', types: [type] }) || [];
}

function outEdges(node, type) {
  return node.getNeighbors({ direction: 'outgoing', types: [type], returnType: 'edges' }) || [];
}

function inEdges(node, type) {
  return node.getNeighbors({ direction: 'incoming', types: [type], returnType: 'edges' }) || [];
}

function inN(node, type) {
  return node.getNeighbors({ direction: 'incoming', types: [type] }) || [];
}

function full(n) {
  // Edge endpoints are node handles; re-fetch to be sure traversal helpers are available.
  if (n && typeof n.getNeighbors === 'function') return n;
  return graph.getNodeById(n.id);
}

function hasLabel(n, l) {
  return (n.labels || []).indexOf(l) >= 0;
}

function parseFacts(f) {
  if (!f) return {};
  if (typeof f === 'string') {
    try {
      return JSON.parse(f);
    } catch (e) {
      return {};
    }
  }
  return f;
}

function evalOp(actual, op, expected) {
  switch (op) {
    case 'lte': return actual <= expected;
    case 'lt': return actual < expected;
    case 'gte': return actual >= expected;
    case 'gt': return actual > expected;
    case 'eq': return actual === expected;
    case 'neq': return actual !== expected;
    case 'in': return (expected || []).indexOf(actual) >= 0;
    case 'nin': return (expected || []).indexOf(actual) < 0;
    default: return true;
  }
}

// ---------------------------------------------------------------- policy

/** Clauses of a PolicyVersion the facts violate, split into the routine envelope and hard limits. */
function violations(factsIn, pv) {
  var facts = parseFacts(factsIn);
  var res = { limit: [], default: [] };
  if (!pv) return res;
  var clauses = out(pv, 'HAS_CLAUSE');
  for (var i = 0; i < clauses.length; i++) {
    var c = clauses[i];
    var rule;
    try {
      rule = JSON.parse(attr(c, 'rule', '{}'));
    } catch (e) {
      continue;
    }
    var v = facts[rule.field];
    if (v === undefined || v === null) continue;
    if (!evalOp(v, rule.op, rule.value)) {
      var kind = attr(c, 'kind', 'limit');
      (kind === 'default' ? res.default : res.limit).push({
        clauseId: attr(c, 'id', ''),
        key: attr(c, 'key', ''),
        field: rule.field,
        op: rule.op,
        value: rule.value,
        actual: v,
      });
    }
  }
  return res;
}

/** The PolicyVersion of a policy in force at time t. */
function versionAt(policy, t) {
  var vs = inN(policy, 'VERSION_OF');
  var best = null;
  for (var i = 0; i < vs.length; i++) {
    var from = attr(vs[i], 'effectiveFrom', 0);
    var to = attr(vs[i], 'effectiveTo', FOREVER);
    if (from <= t && t < to) {
      if (!best || attr(vs[i], 'effectiveFrom', 0) > attr(best, 'effectiveFrom', 0)) best = vs[i];
    }
  }
  return best;
}

function policyOf(pv) {
  var ps = out(pv, 'VERSION_OF');
  return ps.length ? ps[0] : null;
}

// ---------------------------------------------------------------- authority

/** Best authority a person held over a policy at time t: {ok, cap, roleId}. */
function authorityAt(person, policyId, value, t) {
  var best = { ok: false, cap: 0, roleId: null };
  var holds = outEdges(person, 'HOLDS');
  for (var i = 0; i < holds.length; i++) {
    if (!validAt(holds[i], t)) continue;
    var role = full(holds[i].target);
    var grants = outEdges(role, 'MAY_APPROVE');
    for (var j = 0; j < grants.length; j++) {
      var g = grants[j];
      if (!validAt(g, t)) continue;
      if (attr(full(g.target), 'id', '') !== policyId) continue;
      var cap = attr(g, 'cap', 0);
      if (cap > best.cap) best = { ok: cap >= value, cap: cap, roleId: attr(role, 'id', '') };
    }
  }
  return best;
}

function ownedAt(person, accountId, t) {
  var owns = outEdges(person, 'OWNS');
  for (var i = 0; i < owns.length; i++) {
    if (validAt(owns[i], t) && attr(full(owns[i].target), 'id', '') === accountId) return true;
  }
  return false;
}

function delegationAt(person, agentId, policyId, value, t) {
  var ds = outEdges(person, 'DELEGATES');
  var best = { ok: false, cap: 0 };
  for (var i = 0; i < ds.length; i++) {
    var d = ds[i];
    if (!validAt(d, t)) continue;
    if (attr(full(d.target), 'id', '') !== agentId) continue;
    if (attr(d, 'policyId', '') !== policyId) continue;
    var cap = attr(d, 'cap', 0);
    if (cap > best.cap) best = { ok: cap >= value, cap: cap };
  }
  return best;
}

/** Problems with who made a decision, judged at the moment it was made. Departure later is irrelevant. */
function authorityProblems(d) {
  var at = attr(d, 'at', 0);
  var value = attr(d, 'value', 0);
  var policyId = attr(d, 'policyId', '');
  var accountId = attr(d, 'accountId', '');
  var problems = [];
  var makers = out(d, 'MADE_BY');
  if (!makers.length) return [{ code: 'NO_AUTHORITY', detail: 'no decision maker recorded', nodeId: attr(d, 'id', '') }];
  var maker = makers[0];
  var person = maker;
  if (hasLabel(maker, 'Agent')) {
    var auth = out(d, 'ON_AUTHORITY_OF');
    if (!auth.length) {
      return [{ code: 'NO_AUTHORITY', detail: 'agent acted without a delegating person', nodeId: attr(maker, 'id', '') }];
    }
    person = auth[0];
    var del = delegationAt(person, attr(maker, 'id', ''), policyId, value, at);
    if (!del.ok) {
      problems.push({
        code: 'NO_AUTHORITY',
        detail: del.cap > 0 ? 'delegation cap ' + del.cap + ' below ' + value : 'no delegation in force at the time',
        nodeId: attr(person, 'id', ''),
      });
    }
  }
  if (attr(d, 'basis', '') === 'routine') return problems;
  var a = authorityAt(person, policyId, value, at);
  if (!a.ok) {
    problems.push({
      code: 'NO_AUTHORITY',
      detail: a.cap > 0 ? 'approval cap ' + a.cap + ' below ' + value : 'held no approving role at the time',
      nodeId: attr(person, 'id', ''),
    });
  }
  if (accountId && ownedAt(person, accountId, at)) {
    problems.push({ code: 'CONFLICT', detail: 'approver owned the account', nodeId: attr(person, 'id', '') });
  }
  return problems;
}

// ---------------------------------------------------------------- standing

function standingOf(d, now, memo, onStack, depth) {
  var key = d.id;
  if (memo[key]) return memo[key];
  if (onStack[key] || depth > MAX_DEPTH) return { flag: 'green', reasons: [], chain: [] };
  onStack[key] = true;

  var reasons = [];

  var ov = inEdges(d, 'OVERTURNS');
  for (var i = 0; i < ov.length; i++) {
    if (attr(ov[i], 'at', 0) <= now) {
      reasons.push({ code: 'OVERTURNED', detail: attr(ov[i], 'reason', ''), nodeId: attr(full(ov[i].source), 'id', '') });
    }
  }

  var ap = authorityProblems(d);
  for (var k = 0; k < ap.length; k++) reasons.push(ap[k]);

  var applied = out(d, 'APPLIED_POLICY');
  if (applied.length) {
    var policy = policyOf(applied[0]);
    var current = policy ? versionAt(policy, now) : null;
    if (current && current.id !== applied[0].id) {
      var v = violations(attr(d, 'facts', '{}'), current);
      for (var m = 0; m < v.limit.length; m++) {
        reasons.push({
          code: 'SUPERSEDED',
          detail: attr(current, 'id', '') + ' ' + v.limit[m].key + ' (' + v.limit[m].field + ' ' + v.limit[m].op + ' ' + JSON.stringify(v.limit[m].value) + ')',
          nodeId: v.limit[m].clauseId,
        });
      }
    }
  }

  var result;
  if (reasons.length) {
    result = { flag: 'red', reasons: reasons, chain: [] };
  } else {
    result = { flag: 'green', reasons: [], chain: [] };
    var cited = inN(d, 'PRECEDENT_FOR');
    for (var c = 0; c < cited.length; c++) {
      var s = standingOf(cited[c], now, memo, onStack, depth + 1);
      if (s.flag !== 'green') {
        var chain = [attr(cited[c], 'id', '')].concat(s.chain);
        if (result.flag === 'green' || chain.length < result.chain.length) {
          result = {
            flag: 'yellow',
            reasons: [{ code: 'RESTS_ON_RED', detail: 'cites ' + attr(cited[c], 'id', '') + ' (' + s.flag + ')', nodeId: attr(cited[c], 'id', '') }],
            chain: chain,
          };
        }
      }
    }
  }

  onStack[key] = false;
  memo[key] = result;
  return result;
}

/** Good-law flag of a decision at time `now`: {flag: green|yellow|red, reasons[], chain[]}. */
function standing(d, now) {
  if (!d) return null;
  return standingOf(d, now, {}, {}, 0);
}

/** Standing of many decisions sharing one memo (for re-flag sweeps and the policy simulator). */
function standingMany(ds, now) {
  var memo = {};
  var res = [];
  for (var i = 0; i < ds.length; i++) {
    var s = standingOf(ds[i], now, memo, {}, 0);
    res.push({ id: attr(ds[i], 'id', ''), flag: s.flag, reasons: s.reasons, chain: s.chain });
  }
  return res;
}

/** A standing rule is quarantined as soon as any decision it was derived from stops being good law. */
function ruleStatus(rule, now) {
  var status = attr(rule, 'status', 'proposed');
  var basis = out(rule, 'DERIVED_FROM');
  var memo = {};
  for (var i = 0; i < basis.length; i++) {
    if (standingOf(basis[i], now, memo, {}, 0).flag !== 'green') return 'quarantined';
  }
  return status;
}

// ---------------------------------------------------------------- precedent coverage

/**
 * Does precedent `p` cover a new case with `facts`? Same policy and reason; the new case may not be
 * more extreme on any monotone dimension. Returns {covers, partial, maxValue}: partial means it covers
 * everything except the requested value, so the agent can counter-offer p's value.
 */
function covers(p, factsIn) {
  var f = parseFacts(factsIn);
  var pf = parseFacts(attr(p, 'facts', '{}'));
  var res = { covers: false, partial: false, maxValue: attr(p, 'value', 0) };
  if (attr(p, 'policyId', '') !== f.policyId) return res;
  if (pf.reason !== f.reason) return res;
  if ((TIER_RANK[f.tier] || 0) < (TIER_RANK[pf.tier] || 0)) return res;
  if (f.days !== undefined && pf.days !== undefined && f.days > pf.days) return res;
  var outcome = attr(p, 'outcome', '');
  if (outcome !== 'approved' && outcome !== 'counter') return res;
  var pv = attr(p, 'value', 0);
  if (f.value <= pv) res.covers = true;
  else res.partial = true;
  return res;
}

// ---------------------------------------------------------------- erasure

/** Every node/edge string property containing any term (case-insensitive). Used by the erasure certificate. */
function scanTerms(terms, labels, relTypes) {
  var needles = [];
  for (var i = 0; i < (terms || []).length; i++) {
    if (terms[i] && String(terms[i]).length >= 3) needles.push(String(terms[i]).toLowerCase());
  }
  var hits = [];
  function check(kind, label, x) {
    var a = x.attributes || {};
    for (var k in a) {
      var v = a[k];
      var vals = Array.isArray(v) ? v : [v];
      for (var j = 0; j < vals.length; j++) {
        if (typeof vals[j] !== 'string') continue;
        var s = vals[j].toLowerCase();
        for (var n = 0; n < needles.length; n++) {
          if (s.indexOf(needles[n]) >= 0) {
            hits.push({ kind: kind, label: label, id: a.id === undefined ? x.id : a.id, key: k, term: needles[n] });
          }
        }
      }
    }
  }
  for (var l = 0; l < (labels || []).length; l++) {
    for (var node of graph.iterateNodes(labels[l])) check('node', labels[l], node);
  }
  for (var r = 0; r < (relTypes || []).length; r++) {
    for (var edge of graph.iterateEdges(relTypes[r])) check('edge', relTypes[r], edge);
  }
  return hits;
}

// ---------------------------------------------------------------- sha256 (ledger chaining inside a write query)

function sha256(input) {
  var str = unescape(encodeURIComponent(String(input)));
  function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
  var maxWord = Math.pow(2, 32);
  var words = [];
  var bitLen = str.length * 8;
  var hash = [];
  var k = [];
  var primeCounter = 0;
  var isComposite = {};
  for (var candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (var i = 0; i < 313; i += candidate) isComposite[i] = candidate;
      hash[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
    }
  }
  hash = hash.slice(0, 8);
  str += '\x80';
  while ((str.length % 64) - 56) str += '\x00';
  for (i = 0; i < str.length; i++) {
    var j = str.charCodeAt(i);
    words[i >> 2] |= j << (((3 - i) % 4) * 8);
  }
  words[words.length] = (bitLen / maxWord) | 0;
  words[words.length] = bitLen;
  for (j = 0; j < words.length; ) {
    var w = words.slice(j, (j += 16));
    var oldHash = hash;
    hash = hash.slice(0, 8);
    for (i = 0; i < 64; i++) {
      var w15 = w[i - 15], w2 = w[i - 2];
      var a = hash[0], e = hash[4];
      var t1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[i] +
        (w[i] = i < 16 ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
      var t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
      hash = [(t1 + t2) | 0].concat(hash);
      hash[4] = (hash[4] + t1) | 0;
    }
    for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
  }
  var result = '';
  for (i = 0; i < 8; i++) {
    for (j = 3; j + 1; j--) {
      var b = (hash[i] >> (j * 8)) & 255;
      result += (b < 16 ? '0' : '') + b.toString(16);
    }
  }
  return result;
}

falkor.register('sha256', sha256);
falkor.register('standing', standing);
falkor.register('standingMany', standingMany);
falkor.register('violations', violations);
falkor.register('ruleStatus', ruleStatus);
falkor.register('covers', covers);
falkor.register('scanTerms', scanTerms);
