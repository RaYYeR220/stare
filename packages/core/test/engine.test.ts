import { beforeAll, describe, expect, it } from 'vitest';
import { connect, Db } from '../src/db.ts';
import { HashEmbedder } from '../src/embed.ts';
import { decide, type EngineCtx } from '../src/engine/decide.ts';
import { gateExplanation } from '../src/engine/template.ts';
import type { DecideRequest, Verdict } from '../src/engine/types.ts';
import { verifyLedger } from '../src/ledger.ts';
import { HeuristicLlm } from '../src/llm.ts';
import { fixedClock } from '../src/time.ts';
import { copyGraph } from '../src/copy.ts';
import { ANCHOR, buildNorthwind, seedGraph } from '../../seed/src/index.ts';
import { adminClient, freshDb, TEST_URL } from './helpers.ts';

const nw = buildNorthwind();
const NOW = ANCHOR + 3600e3;
let base: string;

beforeAll(async () => {
  const db = await freshDb('engine-base', 32);
  await seedGraph(db, nw, { embedder: new HashEmbedder(32), now: ANCHOR, skipSchema: true });
  base = db.graphName;
}, 120_000);

let n = 0;
async function ctxFor(): Promise<EngineCtx> {
  const admin = await adminClient();
  const name = `${base}-c${++n}`;
  await copyGraph(admin, base, name);
  return { db: new Db(admin, name), llm: new HeuristicLlm(nw.accounts.map((a) => a.name)), embedder: new HashEmbedder(32), clock: fixedClock(NOW) };
}

const agentFor = (ch: string) => (ch.includes('deal') ? 'a-renewals' : ch.includes('billing') ? 'a-billing' : 'a-support');
const inbox = (id: string): DecideRequest => {
  const item = nw.inbox.find((i) => i.id === id)!;
  return { principal: { kind: 'agent', id: agentFor(item.channel) }, text: item.text, channel: item.channel };
};
const run = async (id: string, ctx?: EngineCtx) => decide(ctx ?? (await ctxFor()), inbox(id));
const flagOf = (v: Verdict, account: string) => v.candidates.find((c) => c.account === account)?.standing.flag;

describe('decide() on Northwind Cloud', () => {
  it('hero: counter-offers on good law instead of following the lookalike that rests on an unauthorized approval', async () => {
    const v = await run('in-acme-outage');
    expect(v.outcome).toBe('counter');
    expect(v.value).toBe(1200);
    expect(v.citations.map((c) => c.id)).toEqual([nw.story.goodLawOutage]);
    expect(v.citations[0]!.standing.flag).toBe('green');
    const bluefin = v.candidates.find((c) => c.id === nw.story.restsOnUnauthorized);
    expect(bluefin?.covers).toBe(true);
    expect(bluefin?.standing.flag).toBe('yellow');
    expect(bluefin?.standing.chain).toEqual([nw.story.unauthorized]);
    expect(v.ignoredClaims.join(' ')).toMatch(/signed off/);
    expect(v.decisionId).toBeTruthy();
    expect(v.explanation).toContain('Not relied on: Bluefin Analytics');
  });

  it('a precedent set by an approver who has since left still stands (authority at the time)', async () => {
    const v = await run('in-northstar-like');
    expect(v.outcome).toBe('approved');
    expect(v.basis).toBe('precedent');
    expect(v.citations[0]!.id).toBe(nw.story.departedApprover);
    expect(v.delegation?.name).toBe('Priya Raman');
  });

  it.each([
    ['in-goodwill', '§4.8'],
    ['in-late-refund', '§4.5'],
    ['in-collections', '§4.7'],
    ['in-discount-45', '§2.4'],
    ['in-terms-90', '§3.3'],
  ])('%s is denied by a hard limit of the policy in force (%s)', async (id, key) => {
    const v = await run(id);
    expect(v.outcome).toBe('denied');
    expect(v.basis).toBe('policy');
    expect(v.limitViolations.map((c) => c.key)).toContain(key);
  });

  it('routine requests are approved inside the envelope', async () => {
    const v = await run('in-duplicate');
    expect(v).toMatchObject({ outcome: 'approved', basis: 'routine', value: 240 });
  });

  it('escalates with Overruling Risk when every covering precedent rests on an overturned one', async () => {
    const v = await run('in-churn-yellow');
    expect(v.outcome).toBe('escalated');
    expect(v.refusal?.code).toBe('OVERRULING_RISK');
    expect(v.route?.name).toBe('Priya Raman');
    expect(v.escalationId).toBeTruthy();
    expect(flagOf(v, 'Halcyon Media')).toBe('red');
  });

  it('refuses entities that are not in the graph', async () => {
    const v = await run('in-unknown');
    expect(v.outcome).toBe('not_in_graph');
    expect(v.caseId).toBeNull();
  });

  it('ignores instructions and claims embedded in the request', async () => {
    const v = await run('in-injection');
    expect(v.outcome).toBe('escalated');
    expect(v.ignoredClaims.length).toBeGreaterThan(0);
  });

  it('applies a ratified standing rule (procedural memory)', async () => {
    const v = await run('in-multiyear');
    expect(v).toMatchObject({ outcome: 'approved', basis: 'rule' });
    expect(v.rule?.id).toBe(nw.story.ratifiedRule);
  });

  it('escalates to the delegator when good law covers it but the delegation does not', async () => {
    const v = await run('in-discount-22');
    expect(v.outcome).toBe('escalated');
    expect(v.refusal?.code).toBe('OVER_DELEGATION');
    expect(v.route).toMatchObject({ name: 'Marcus Chen', hops: 0 });
  });

  it('never cites a conflicted approval', async () => {
    const v = await run('in-lumen');
    expect(v.outcome).toBe('approved');
    expect(v.citations.map((c) => c.id)).not.toContain(nw.story.conflict);
    expect(flagOf(v, 'Lumen Retail')).toBe('red');
  });

  it('routes over the live reporting graph with algo.SPpaths', async () => {
    const v = await run('in-terms-60');
    expect(v.outcome).toBe('counter');
    expect(v.route).toMatchObject({ name: 'Tomás Ibarra', hops: 1 });
    expect(v.route?.pathIds).toEqual(['p-grace', 'p-tomas']);
    expect(v.trace.some((t) => t.cypher.includes('algo.SPpaths'))).toBe(true);
  });

  it('is idempotent: the same request twice, or eight at once, yields exactly one decision', async () => {
    const ctx = await ctxFor();
    const req = { ...inbox('in-northstar-like'), key: 'k-1' };
    const first = await decide(ctx, req);
    const again = await decide(ctx, req);
    expect(again.decisionId).toBe(first.decisionId);
    expect(again.refusal?.code).toBe('REPLAY');
    const clients = await Promise.all(Array.from({ length: 8 }, () => connect({ url: TEST_URL })));
    const out = await Promise.all(clients.map((c) => decide({ ...ctx, db: new Db(c, ctx.db.graphName) }, { ...req, key: 'k-2' })));
    await Promise.all(clients.map((c) => c.close()));
    expect(new Set(out.map((o) => o.decisionId)).size).toBe(1);
    const [row] = await ctx.db.ro<{ n: number }>("MATCH (d:Decision)-[:DECIDES]->(c:Case {key:'k-2'}) RETURN count(d) AS n");
    expect(row!.n).toBe(1);
  });

  it('spends the autonomy budget atomically and escalates once it is gone', async () => {
    const ctx = await ctxFor();
    await ctx.db.rw("MATCH (b:Budget {id:'budget-refunds-2026q4'}) SET b.remaining = 2500");
    const reqs = Array.from({ length: 6 }, (_, i) => ({ ...inbox('in-northstar-like'), key: `b-${i}` }));
    const clients = await Promise.all(reqs.map(() => connect({ url: TEST_URL })));
    const out = await Promise.all(reqs.map((r, i) => decide({ ...ctx, db: new Db(clients[i]!, ctx.db.graphName) }, r)));
    await Promise.all(clients.map((c) => c.close()));
    const approved = out.filter((o) => o.outcome === 'approved');
    expect(approved.length).toBe(1);
    expect(out.filter((o) => o.refusal?.code === 'BUDGET_EXHAUSTED').length).toBe(5);
    const [b] = await ctx.db.ro<{ r: number }>("MATCH (b:Budget {id:'budget-refunds-2026q4'}) RETURN b.remaining AS r");
    expect(b!.r).toBe(600);
  });

  it('dry run decides without writing anything', async () => {
    const ctx = await ctxFor();
    const [before] = await ctx.db.ro<{ n: number }>('MATCH (n) RETURN count(n) AS n');
    const v = await decide(ctx, { ...inbox('in-acme-outage'), dryRun: true });
    expect(v.outcome).toBe('counter');
    expect(v.decisionId).toBeNull();
    const [after] = await ctx.db.ro<{ n: number }>('MATCH (n) RETURN count(n) AS n');
    expect(after!.n).toBe(before!.n);
  });

  it('keeps the ledger verifiable after live decisions', async () => {
    const ctx = await ctxFor();
    for (const id of ['in-acme-outage', 'in-churn-yellow', 'in-goodwill', 'in-duplicate']) await decide(ctx, inbox(id));
    const v = await verifyLedger(ctx.db, { deep: true });
    expect(v.ok).toBe(true);
  });

  it('records the exact Cypher that ran, by name', async () => {
    const v = await run('in-acme-outage');
    const names = v.trace.map((t) => t.name);
    for (const q of ['engine.resolveAccount', 'engine.policyNow', 'engine.delegation', 'engine.evaluateCandidates', 'engine.commitDecision']) {
      expect(names).toContain(q);
    }
  });
});

describe('explanation gate', () => {
  it('rejects a model explanation that names someone or something outside the trace', async () => {
    const v = await decide(await ctxFor(), { ...inbox('in-acme-outage'), dryRun: true });
    const allowed = ['Acme Logistics', 'Fernway Travel', 'Ana Ruiz', 'Priya Raman', 'Bluefin Analytics'];
    expect(gateExplanation('We can offer $1,200 to Acme Logistics, following Fernway Travel.', v, allowed).ok).toBe(true);
    expect(gateExplanation('Approved because Dana Whitfield said so.', v, allowed).offending).toEqual(['Dana Whitfield']);
    expect(gateExplanation('We refunded $1,750 to Acme Logistics.', v, allowed).ok).toBe(false);
  });
});
