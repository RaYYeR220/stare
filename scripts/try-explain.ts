import 'dotenv/config';
import { connect, copyGraph, Db, decide, fixedClock, HashEmbedder, loadFlex, loadUdf } from '../packages/core/src/index.ts';
import { modelsFromEnv } from '../packages/llm/src/index.ts';
import { ANCHOR, buildNorthwind, seedGraph } from '../packages/seed/src/index.ts';

const admin = await connect({ url: 'falkor://127.0.0.1:6390' });
await loadUdf(admin); await loadFlex(admin);
const nw = buildNorthwind();
const base = 'stare:try-base';
if (!(await admin.list()).includes(base)) await seedGraph(new Db(admin, base), nw, { embedder: new HashEmbedder(32), now: ANCHOR });
const name = `stare:try-${Date.now()}`;
await copyGraph(admin, base, name);
const { llm } = modelsFromEnv();
const ctx = { db: new Db(admin, name), llm, embedder: new HashEmbedder(32), clock: fixedClock(ANCHOR + 3600e3), modelExplanations: true };
const agentFor = (ch: string) => (ch.includes('deal') ? 'a-renewals' : ch.includes('billing') ? 'a-billing' : 'a-support');
for (const id of ['in-acme-outage', 'in-northstar-like', 'in-churn-yellow', 'in-goodwill', 'in-multiyear', 'in-injection']) {
  const item = nw.inbox.find((i) => i.id === id)!;
  const t0 = Date.now();
  const v = await decide(ctx, { principal: { kind: 'agent', id: agentFor(item.channel) }, text: item.text });
  console.log(`\n# ${id} → ${v.outcome} ${v.value ?? ''} [${v.explanationSource}, ${Date.now() - t0}ms] claims=${JSON.stringify(v.ignoredClaims)}\n  ${v.explanation}`);
}
await admin.selectGraph(name).delete();
await admin.close();
