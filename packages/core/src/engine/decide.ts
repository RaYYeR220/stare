import { randomBytes } from 'node:crypto';
import { type Db, QueryRecorder } from '../db.ts';
import type { Embedder } from '../embed.ts';
import { canonicalJson, ledgerParams, sha256Hex } from '../ledger.ts';
import { type Llm, REASONS } from '../llm.ts';
import type { Clock } from '../time.ts';
import { Q } from './queries.ts';
import { allowedMentions, gateExplanation, templateExplanation } from './template.ts';
import type {
  Basis, Candidate, ClauseHit, DecideRequest, Intake, Outcome, PolicyId, Route, Standing, Verdict,
} from './types.ts';
import { POLICY_IDS } from './types.ts';

export interface EngineCtx {
  /** Tenant-scoped connection (the tenant's ACL user). */
  db: Db;
  llm: Llm;
  embedder: Embedder;
  clock: Clock;
  /** Ask the model for the explanation (gated). Off → deterministic template only. */
  modelExplanations?: boolean;
}

export const RESOLVE_THRESHOLD = 0.92;
const VECTOR_K = 24;

const rid = (p: string) => `${p}-${randomBytes(5).toString('hex')}`;

function blank(intake: Intake, now: number, dryRun: boolean): Verdict {
  return {
    outcome: 'needs_info', requested: intake.value, value: null, basis: 'none', policyId: intake.policyId, policyVersionId: null,
    account: null, intake, ignoredClaims: intake.claims, limitViolations: [], defaultViolations: [], delegation: null, rule: null,
    citations: [], candidates: [], route: null, budget: null, refusal: null, caseId: null, decisionId: null, escalationId: null,
    ledgerSeq: null, explanation: '', explanationSource: 'template', at: now, dryRun, trace: [],
  };
}

interface Plan {
  outcome: Outcome;
  value: number | null;
  basis: Basis;
  citations: Candidate[];
  ruleId: string | null;
  refusal: { code: string; detail: string } | null;
  escalate: boolean;
}

/**
 * Decide a request. Every step that matters is a named Cypher query and every check that decides
 * an outcome runs inside FalkorDB (stare.* UDFs, algo.SPpaths). The model only parses and explains.
 */
export async function decide(ctx: EngineCtx, req: DecideRequest): Promise<Verdict> {
  const now = ctx.clock.now();
  const rec = new QueryRecorder();
  const db = ctx.db.withRecorder(rec);
  const dryRun = !!req.dryRun;

  const intake = req.intake ?? (await ctx.llm.parseRequest(req.text ?? '', { policies: POLICY_IDS, reasons: REASONS }));
  const v = blank(intake, now, dryRun);
  const finish = async (): Promise<Verdict> => {
    v.trace = rec.entries;
    if (!v.explanation) await explain(ctx, db, v, req);
    v.trace = rec.entries;
    return v;
  };

  // ---------------------------------------------------------------- resolve the account
  if (!intake.accountName) {
    v.outcome = 'not_in_graph';
    v.refusal = { code: 'NO_ACCOUNT', detail: 'no account named in the request' };
    return finish();
  }
  const accounts = await db.ro<{ id: string; name: string; tier: string; status: string; score: number; ownerId: string | null; ownerName: string | null }>(
    Q.resolveAccount,
    { name: intake.accountName, threshold: RESOLVE_THRESHOLD, now },
  );
  if (!accounts.length) {
    v.outcome = 'not_in_graph';
    v.refusal = { code: 'NOT_IN_GRAPH', detail: `no account matches "${intake.accountName}"` };
    return finish();
  }
  const [best, second] = accounts;
  if (second && best!.score < 1 && best!.score - second.score < 0.02) {
    v.outcome = 'needs_info';
    v.refusal = { code: 'AMBIGUOUS', detail: `"${intake.accountName}" matches both ${best!.name} and ${second.name}` };
    return finish();
  }
  v.account = best!;

  // ---------------------------------------------------------------- required fields
  const missing: string[] = [];
  if (!intake.policyId) missing.push('what is being asked for (refund, discount or payment terms)');
  if (intake.value == null) missing.push('the amount');
  if (intake.policyId === 'refunds' && intake.days == null) missing.push('days since the charge');
  if (missing.length) {
    v.outcome = 'needs_info';
    v.refusal = { code: 'MISSING_FIELDS', detail: missing.join(', ') };
    return finish();
  }
  const policyId = intake.policyId as PolicyId;
  const value = intake.value as number;
  const reason = intake.reason ?? 'unspecified';
  v.policyId = policyId;
  v.requested = value;
  const facts = { policyId, value, days: intake.days, reason, tier: best!.tier, accountStatus: best!.status };
  const factsJson = JSON.stringify(facts);

  // ---------------------------------------------------------------- policy in force
  const [pol] = await db.ro<{ versionId: string; violations: { limit: ClauseHit[]; default: ClauseHit[] }; clauses: { id: string; key: string; text: string }[] }>(
    Q.policyNow,
    { policyId, now, facts: factsJson },
  );
  if (!pol) {
    v.outcome = 'denied';
    v.refusal = { code: 'NO_POLICY', detail: `no ${policyId} policy is in force` };
    return finish();
  }
  const clauseText = new Map(pol.clauses.map((c) => [c.id, c.text]));
  v.policyVersionId = pol.versionId;
  v.limitViolations = pol.violations.limit.map((c) => ({ ...c, text: clauseText.get(c.clauseId) }));
  v.defaultViolations = pol.violations.default.map((c) => ({ ...c, text: clauseText.get(c.clauseId) }));
  const routine = v.defaultViolations.length === 0;

  // ---------------------------------------------------------------- open the case (idempotent)
  let contactId: string | null = null;
  if (!dryRun) {
    const contacts = await db.ro<{ id: string; name: string }>(Q.contactsOf, { accountId: best!.id });
    const text = (req.text ?? '').toLowerCase();
    const mentioned = contacts.filter((c) => text.includes(c.name.toLowerCase()) || (c.name.split(' ')[0]!.length >= 4 && new RegExp(`\\b${c.name.split(' ')[0]!.toLowerCase()}\\b`).test(text)));
    contactId = mentioned[0]?.id ?? null;
    const key = req.key ?? sha256Hex(canonicalJson({ p: req.principal, facts, account: best!.id, text: req.text ?? '' }));
    const caseId = rid('case');
    const [c] = (
      await db.rw<{ id: string; status: string; created: boolean; decisionId: string | null; escalationId: string | null }>(Q.caseUpsert, {
        key, caseId, policyId, accountId: best!.id, value, days: intake.days, reason, tier: best!.tier, accountStatus: best!.status,
        text: req.text ?? '', now, filedBy: req.principal.id, nonce: randomBytes(8).toString('hex'),
      })
    ).rows;
    v.caseId = c!.id;
    if (!c!.created) return replay(db, v, c!, finish);
    const [vec] = await ctx.embedder.embed([req.text || `${best!.name} ${policyId} ${value} ${reason}`]);
    await db.rw(Q.caseLinks, {
      caseId: c!.id, accountId: best!.id, reason, sourceId: rid('src'), spanId: rid('span'), title: `${best!.name} — ${policyId}`,
      channel: req.channel ?? 'desk', text: req.text ?? '', now, filedBy: req.principal.id, vec, contactIds: mentioned.map((m) => m.id),
    });
  }

  // ---------------------------------------------------------------- plan
  const plan = await planOutcome(ctx, db, v, { policyId, value, reason, facts, factsJson, routine, now, req, accountId: best!.id });
  v.outcome = plan.outcome;
  v.value = plan.value;
  v.basis = plan.basis;
  v.citations = plan.citations;
  v.refusal = plan.refusal;

  if (plan.escalate) {
    await planRoute(db, v, { policyId, value, now, accountId: best!.id, req });
    if (!v.route) {
      v.outcome = 'denied';
      v.basis = 'none';
      v.refusal = { code: 'NO_APPROVER', detail: 'nobody holds authority for this amount right now' };
    }
  }
  if (dryRun) return finish();

  // ---------------------------------------------------------------- commit
  const commitment = contactId ? await subjectCommitment(db, contactId) : null;
  if (v.outcome === 'escalated') {
    await commitEscalation(db, v, now, commitment);
    return finish();
  }
  const committed = await commitDecision(db, v, { now, req, commitment, ruleId: plan.ruleId, reason });
  if (!committed) {
    // A check inside the write failed (budget spent, precedent changed, policy changed, or a concurrent duplicate).
    const [existing] = await db.ro<{ id: string }>(Q.existingDecision, { caseId: v.caseId });
    if (existing) return replay(db, v, { id: v.caseId!, status: 'decided', created: false, decisionId: existing.id, escalationId: null }, finish);
    const [b] = await db.ro<{ remaining: number }>(Q.budget, { policyId, now });
    v.outcome = 'escalated';
    v.basis = 'none';
    v.refusal = b && v.budget && b.remaining < v.budget.cost
      ? { code: 'BUDGET_EXHAUSTED', detail: `the autonomy budget has ${b.remaining} left` }
      : { code: 'CHANGED_UNDER_US', detail: 'the precedent or policy changed while deciding' };
    await planRoute(db, v, { policyId, value, now, accountId: v.account!.id, req });
    if (v.route) await commitEscalation(db, v, now, commitment);
    else {
      v.outcome = 'denied';
      v.refusal = { code: 'NO_APPROVER', detail: 'nobody holds authority for this amount right now' };
    }
  }
  return finish();
}

interface PlanInput {
  policyId: PolicyId;
  value: number;
  reason: string;
  facts: Record<string, unknown>;
  factsJson: string;
  routine: boolean;
  now: number;
  req: DecideRequest;
  accountId: string;
}

async function planOutcome(ctx: EngineCtx, db: Db, v: Verdict, p: PlanInput): Promise<Plan> {
  const plan: Plan = { outcome: 'escalated', value: null, basis: 'none', citations: [], ruleId: null, refusal: null, escalate: true };

  // Who may act: an agent acts only on a live delegation from someone who still holds that authority.
  let effectiveCap = 0;
  if (p.req.principal.kind === 'agent') {
    const dels = await db.ro<{ personId: string; name: string; delegated: number; authority: number }>(Q.delegation, {
      agentId: p.req.principal.id, policyId: p.policyId, now: p.now, accountId: p.accountId,
    });
    const bestDel = dels.map((d) => ({ ...d, cap: Math.min(d.delegated, d.authority) })).sort((a, b) => b.cap - a.cap)[0];
    if (bestDel && bestDel.cap > 0) {
      v.delegation = { personId: bestDel.personId, name: bestDel.name, cap: bestDel.cap };
      effectiveCap = bestDel.cap;
    }
  }

  if (v.limitViolations.length) {
    const c = v.limitViolations[0]!;
    return { ...plan, outcome: 'denied', value: 0, basis: 'policy', escalate: false, refusal: { code: 'POLICY_LIMIT', detail: `${v.policyVersionId} ${c.key}: ${c.text ?? ''}` } };
  }

  if (p.routine) {
    if (p.req.principal.kind === 'person' || effectiveCap >= p.value) return { ...plan, outcome: 'approved', value: p.value, basis: 'routine', escalate: false };
    return { ...plan, refusal: { code: 'NO_DELEGATION', detail: 'the agent holds no live delegation for this policy' } };
  }
  if (!p.reason || p.reason === 'unspecified') {
    return { ...plan, outcome: 'needs_info', escalate: false, refusal: { code: 'MISSING_FIELDS', detail: 'the reason for the exception' } };
  }

  // Precedent candidates (always computed: the trace shows them even when a rule decides).
  const [qvec] = await ctx.embedder.embed([p.req.text || `${v.account!.name} ${p.policyId} ${p.value} ${p.reason}`]);
  const seeds = await db.ro<{ id: string; score: number }>(Q.vectorSeeds, { k: VECTOR_K, vec: qvec, policyId: p.policyId, now: p.now });
  const structural = await db.ro<{ id: string }>(Q.structuralIds, { policyId: p.policyId, reason: p.reason, now: p.now });
  const sim = new Map(seeds.map((s) => [s.id, Math.round((1 - s.score) * 1000) / 1000]));
  const structIds = new Set(structural.map((s) => s.id));
  const ids = [...new Set([...sim.keys(), ...structIds])];
  const rows = ids.length
    ? await db.ro<{ id: string; value: number; at: number; facts: string; outcome: string; account: string; madeBy: string; makerKind: string; cover: { covers: boolean; partial: boolean }; standing: Standing }>(
        Q.evaluateCandidates,
        { ids, facts: p.factsJson, now: p.now },
      )
    : [];
  const candidates: Candidate[] = rows.map((r) => {
    const f = JSON.parse(r.facts || '{}');
    return {
      id: r.id, account: r.account, value: r.value, at: r.at, reason: f.reason, tier: f.tier, days: f.days ?? null, madeBy: r.madeBy,
      makerKind: r.makerKind === 'Agent' ? 'Agent' : 'Person', standing: r.standing, covers: r.cover.covers, partial: r.cover.partial,
      similarity: sim.get(r.id) ?? null, via: sim.has(r.id) && structIds.has(r.id) ? 'both' : sim.has(r.id) ? 'vector' : 'structure',
    };
  });
  const rank = (a: Candidate, b: Candidate) => (b.similarity ?? -1) - (a.similarity ?? -1) || b.at - a.at;
  const relevant = candidates.filter((c) => c.covers || c.partial).sort(rank);
  v.candidates = relevant.slice(0, 12);

  if (p.req.principal.kind === 'person') {
    return { ...plan, citations: relevant.filter((c) => c.covers && c.standing.flag === 'green').slice(0, 3), refusal: { code: 'HUMAN_FILED', detail: 'exceptions filed by people go to an approver' } };
  }

  // Standing rule fast path (procedural memory), still bounded by delegation and budget.
  const [rule] = await db.ro<{ id: string; text: string; maxValue: number }>(Q.rule, { policyId: p.policyId, reason: p.reason, tier: v.account!.tier, value: p.value, now: p.now });

  const [budget] = await db.ro<{ id: string; unit: string; cap: number; remaining: number }>(Q.budget, { policyId: p.policyId, now: p.now });
  const costOf = (x: number) => (budget?.unit === 'count' ? 1 : x);
  if (budget) v.budget = { id: budget.id, unit: budget.unit, cap: budget.cap, remaining: budget.remaining, cost: costOf(p.value) };
  const budgetAllows = (x: number) => !budget || budget.remaining >= costOf(x);

  if (rule && effectiveCap >= p.value && budgetAllows(p.value)) {
    v.rule = rule;
    return { ...plan, outcome: 'approved', value: p.value, basis: 'rule', ruleId: rule.id, escalate: false };
  }

  const green = relevant.filter((c) => c.standing.flag === 'green');
  const full = green.filter((c) => c.covers);
  const partial = green.filter((c) => c.partial).sort((a, b) => b.value - a.value);
  if (full.length) {
    const citations = full.slice(0, 3);
    for (const c of citations) if (!v.candidates.some((x) => x.id === c.id)) v.candidates.push(c);
    if (!v.delegation) return { ...plan, citations, refusal: { code: 'NO_DELEGATION', detail: 'covered by good law, but the agent holds no live delegation' } };
    if (effectiveCap < p.value) return { ...plan, citations, refusal: { code: 'OVER_DELEGATION', detail: `covered by good law, but above the agent's delegation` } };
    if (!budgetAllows(p.value)) return { ...plan, citations, refusal: { code: 'BUDGET_EXHAUSTED', detail: `the autonomy budget has ${budget!.remaining} left` } };
    return { ...plan, outcome: 'approved', value: p.value, basis: 'precedent', citations, escalate: false };
  }
  if (partial.length && v.delegation) {
    const counter = Math.min(partial[0]!.value, effectiveCap);
    if (counter > 0 && budgetAllows(counter)) {
      // A suggestion of who could grant the full amount, without opening an escalation.
      await planRoute(db, v, { policyId: p.policyId, value: p.value, now: p.now, accountId: p.accountId, req: p.req });
      if (!v.candidates.some((c) => c.id === partial[0]!.id)) v.candidates = [partial[0]!, ...v.candidates.slice(0, 11)];
      return { ...plan, outcome: 'counter', value: counter, basis: 'precedent', citations: [partial[0]!], escalate: false };
    }
  }
  const unsound = relevant.filter((c) => c.covers && c.standing.flag !== 'green');
  if (unsound.length) {
    const u = unsound[0]!;
    return { ...plan, refusal: { code: u.standing.flag === 'yellow' ? 'OVERRULING_RISK' : 'BAD_LAW', detail: `the only precedent that covers it (${u.account}) is ${u.standing.flag === 'yellow' ? 'resting on a precedent that is no longer good law' : 'no longer good law'}` } };
  }
  return { ...plan, refusal: { code: 'NO_PRECEDENT', detail: 'no good-law precedent covers it' } };
}

async function planRoute(db: Db, v: Verdict, p: { policyId: PolicyId; value: number; now: number; accountId: string; req: DecideRequest }) {
  const approvers = await db.ro<{ id: string; name: string; cap: number }>(Q.approvers, {
    policyId: p.policyId, value: p.value, now: p.now, accountId: p.accountId, exclude: p.req.principal.kind === 'person' ? [p.req.principal.id] : [],
  });
  if (!approvers.length) {
    v.route = null;
    return;
  }
  // Start from the people whose authority the agent works under; otherwise from the account owner or filer.
  const sources = [...new Set([v.delegation?.personId, p.req.principal.kind === 'person' ? p.req.principal.id : null, v.account?.ownerId].filter(Boolean) as string[])];
  const cap = new Map(approvers.map((a) => [a.id, a]));
  const self = approvers.find((a) => sources.includes(a.id));
  let route: Route | null = self ? { personId: self.id, name: self.name, cap: self.cap, pathIds: [self.id], pathNames: [self.name], hops: 0 } : null;
  if (!route && sources.length) {
    const paths = await db.ro<{ id: string; hops: number; pathIds: string[]; pathNames: string[] }>(Q.routes, { sources, cands: approvers.map((a) => a.id) });
    const bestPath = paths.sort((a, b) => a.hops - b.hops || cap.get(a.id)!.cap - cap.get(b.id)!.cap)[0];
    if (bestPath) route = { personId: bestPath.id, name: cap.get(bestPath.id)!.name, cap: cap.get(bestPath.id)!.cap, pathIds: bestPath.pathIds, pathNames: bestPath.pathNames, hops: bestPath.hops };
  }
  if (!route) {
    const a = approvers[0]!; // least privilege that suffices
    route = { personId: a.id, name: a.name, cap: a.cap, pathIds: [a.id], pathNames: [a.name], hops: -1 };
  }
  v.route = route;
}

async function subjectCommitment(db: Db, contactId: string): Promise<string | null> {
  const [row] = await db.ro<{ salt: string }>(Q.salt, { contactId });
  return row ? sha256Hex(`${row.salt}|${contactId}`) : null;
}

async function commitDecision(db: Db, v: Verdict, o: { now: number; req: DecideRequest; commitment: string | null; ruleId: string | null; reason: string }): Promise<boolean> {
  const decisionId = rid('dec');
  const exception = v.outcome !== 'denied' && v.basis !== 'routine';
  const cost = exception && v.budget ? (v.budget.unit === 'count' ? 1 : (v.value ?? 0)) : 0;
  const madeBy = o.req.principal.id;
  const onAuthorityOf = o.req.principal.kind === 'agent' ? (v.delegation?.personId ?? null) : null;
  const citeIds = v.citations.map((c) => c.id);
  const payload = {
    caseId: v.caseId, outcome: v.outcome, value: v.value, basis: v.basis, policyVersionId: v.policyVersionId, madeBy, at: o.now,
    onAuthorityOf, accountId: v.account!.id, cites: citeIds, subjectCommitment: o.commitment,
  };
  const facts = { policyId: v.policyId, value: v.value, requested: v.requested, days: v.intake.days, reason: o.reason, tier: v.account!.tier, accountStatus: v.account!.status };
  const { rows } = await db.rw<{ id: string; seq: number; remaining: number | null }>(Q.commitDecision, {
    caseId: v.caseId, pvId: v.policyVersionId, makerId: madeBy, accountId: v.account!.id, reason: o.reason, budgetId: v.budget?.id ?? '',
    cost, citeIds, sims: v.citations.map((c) => ({ id: c.id, sim: c.similarity ?? 0 })), ruleId: o.ruleId ?? '', authId: onAuthorityOf ?? '',
    decisionId, outcome: v.outcome, value: v.value ?? 0, requested: v.requested, basis: v.basis, now: o.now, policyId: v.policyId,
    facts: JSON.stringify(facts), narrative: templateExplanation(v), exception,
    ...ledgerParams('decision', decisionId, o.now, payload),
  });
  if (!rows.length) return false;
  v.decisionId = rows[0]!.id;
  v.ledgerSeq = rows[0]!.seq;
  if (v.budget && rows[0]!.remaining != null) v.budget.remaining = rows[0]!.remaining;
  return true;
}

async function commitEscalation(db: Db, v: Verdict, now: number, commitment: string | null) {
  const escalationId = rid('esc');
  const payload = {
    caseId: v.caseId, routeTo: v.route!.personId, pathIds: v.route!.pathIds, why: v.refusal?.code ?? 'NO_PRECEDENT', requested: v.requested,
    policyId: v.policyId, accountId: v.account!.id, at: now, subjectCommitment: commitment,
  };
  const { rows } = await db.rw<{ id: string; seq: number }>(Q.commitEscalation, {
    caseId: v.caseId, routeTo: v.route!.personId, escalationId, now, pathIds: v.route!.pathIds, why: v.refusal?.code ?? 'NO_PRECEDENT',
    ...ledgerParams('escalation', escalationId, now, payload),
  });
  if (rows.length) {
    v.escalationId = rows[0]!.id;
    v.ledgerSeq = rows[0]!.seq;
  }
}

async function replay(
  db: Db,
  v: Verdict,
  c0: { id: string; status: string; decisionId: string | null; escalationId: string | null },
  finish: () => Promise<Verdict>,
): Promise<Verdict> {
  let c = c0;
  v.caseId = c.id;
  // The original request may still be deciding: wait briefly for its outcome rather than guess.
  for (let i = 0; i < 40 && !c.decisionId && !c.escalationId; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const [d] = await db.ro<{ id: string }>(Q.existingDecision, { caseId: c.id });
    const [e] = await db.ro<{ id: string }>({ name: 'engine.openEscalation', mode: 'ro', doc: 'Open escalation for a case.', cypher: "MATCH (e:Escalation {status:'open'})-[:FOR]->(:Case {id:$caseId}) RETURN e.id AS id" }, { caseId: c.id });
    c = { ...c, decisionId: d?.id ?? null, escalationId: e?.id ?? null };
  }
  if (c.decisionId) {
    const [d] = await db.ro<{ id: string; outcome: Outcome; value: number; requested: number; basis: Basis; seq: number; narrative: string; policyVersionId: string }>(Q.existingDecision, { caseId: c.id });
    if (d) {
      v.outcome = d.outcome;
      v.value = d.value;
      v.basis = d.basis;
      v.decisionId = d.id;
      v.ledgerSeq = d.seq;
      v.policyVersionId = d.policyVersionId;
      v.explanation = d.narrative;
      v.refusal = { code: 'REPLAY', detail: 'this request was already decided; returning the recorded decision' };
      return finish();
    }
  }
  v.outcome = 'escalated';
  v.escalationId = c.escalationId;
  v.refusal = { code: 'REPLAY', detail: 'this request is already waiting for an approver' };
  v.explanation = 'This request is already escalated and waiting for an approver.';
  return finish();
}

async function explain(ctx: EngineCtx, db: Db, v: Verdict, req: DecideRequest) {
  const template = templateExplanation(v);
  v.explanation = template;
  v.explanationSource = 'template';
  if (ctx.modelExplanations && ctx.llm.model !== 'heuristic' && !['not_in_graph', 'needs_info'].includes(v.outcome)) {
    try {
      const allowed = allowedMentions(v);
      const text = await Promise.race([
        ctx.llm.explain(v, allowed),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), 12_000)),
      ]);
      const gate = gateExplanation(text, v, allowed);
      if (gate.ok) {
        v.explanation = text.trim();
        v.explanationSource = 'model';
      }
    } catch {
      // fall back to the template
    }
  }
  if (v.decisionId && !v.dryRun) {
    const [vec] = await ctx.embedder.embed([`${v.explanation}\n${req.text ?? ''}`]);
    await db.rw(Q.setNarrative, { id: v.decisionId, narrative: v.explanation, vec });
  }
}
