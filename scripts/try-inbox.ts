import { connect, copyGraph, Db, decide, fixedClock, HashEmbedder, HeuristicLlm, loadFlex, loadUdf } from '../packages/core/src/index.ts';
import { applySchema } from '../packages/core/src/schema.ts';
import { ANCHOR, buildNorthwind, seedGraph } from '../packages/seed/src/index.ts';

const admin = await connect({ url: 'falkor://127.0.0.1:6390' });
await loadUdf(admin);
await loadFlex(admin);
const base = 'stare:try-base';
const nw = buildNorthwind();
if (!(await admin.list()).includes(base)) {
  await seedGraph(new Db(admin, base), nw, { embedder: new HashEmbedder(32), now: ANCHOR });
}
const name = `stare:try-${Date.now()}`;
await copyGraph(admin, base, name);
const db = new Db(admin, name);
const llm = new HeuristicLlm(nw.accounts.map((a) => a.name));
const ctx = { db, llm, embedder: new HashEmbedder(32), clock: fixedClock(ANCHOR + 3600e3) };
const agentFor = (ch: string) => (ch.includes('deal') ? 'a-renewals' : ch.includes('billing') ? 'a-billing' : 'a-support');
for (const item of nw.inbox) {
  const v = await decide(ctx, { principal: { kind: 'agent', id: agentFor(item.channel) }, text: item.text, channel: item.channel });
  console.log(`\n# ${item.id}  [expect: ${item.expect}]`);
  console.log(`  → ${v.outcome} ${v.value ?? ''} basis=${v.basis} refusal=${v.refusal?.code ?? '-'} route=${v.route ? `${v.route.name}(${v.route.hops})` : '-'} intake=${JSON.stringify({ p: v.intake.policyId, a: v.intake.accountName, v: v.intake.value, d: v.intake.days, r: v.intake.reason })}`);
  console.log(`  cites: ${v.citations.map((c) => `${c.account}:${c.value}:${c.standing.flag}`).join(', ') || '-'} | candidates: ${v.candidates.slice(0, 5).map((c) => `${c.account}:${c.value}:${c.standing.flag}${c.covers ? '' : '~'}`).join(', ')}`);
  console.log(`  ${v.explanation}`);
}
await admin.selectGraph(name).delete();
await admin.close();
