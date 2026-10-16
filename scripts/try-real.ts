import 'dotenv/config';
import { ablate, connect, copyGraph, Db, decide, fixedClock } from '../packages/core/src/index.ts';
import { CachedEmbedder, modelsFromEnv } from '../packages/llm/src/index.ts';
import { ANCHOR, buildNorthwind } from '../packages/seed/src/index.ts';
import { EMBED_CACHE } from '../packages/seed/src/cli.ts';

const admin = await connect({ url: 'falkor://127.0.0.1:6390' });
const nw = buildNorthwind();
const name = `stare:try-${Date.now()}`;
await copyGraph(admin, 'stare:tpl:northwind', name);
const m = modelsFromEnv();
const embedder = new CachedEmbedder(m.embedder, EMBED_CACHE);
const ctx = { db: new Db(admin, name), llm: m.llm, embedder, clock: fixedClock(ANCHOR + 3600e3) };
const agentFor = (ch: string) => (ch.includes('deal') ? 'a-renewals' : ch.includes('billing') ? 'a-billing' : 'a-support');
let agree = 0;
for (const item of nw.inbox) {
  const req = { principal: { kind: 'agent' as const, id: agentFor(item.channel) }, text: item.text };
  const [v, a] = [await decide(ctx, { ...req, dryRun: true }), await ablate(ctx, req)];
  const same = (v.outcome === a.outcome) && (v.value ?? 0) === (a.value ?? 0);
  if (same) agree++;
  console.log(`${item.id.padEnd(18)} stare=${v.outcome} ${v.value ?? ''} | vector-only=${a.outcome} ${a.value ?? ''} via ${a.precedent ? `${a.precedent.account} (${a.precedent.standing.flag}, sim ${a.precedent.similarity})` : '-'}`);
}
console.log(`agree ${agree}/${nw.inbox.length}`);
embedder.save();
await admin.selectGraph(name).delete();
await admin.close();
