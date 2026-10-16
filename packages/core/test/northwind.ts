import { ANCHOR, buildNorthwind, seedGraph } from '../../seed/src/index.ts';
import { copyGraph } from '../src/copy.ts';
import { Db } from '../src/db.ts';
import { HashEmbedder } from '../src/embed.ts';
import type { EngineCtx } from '../src/engine/decide.ts';
import type { DecideRequest } from '../src/engine/types.ts';
import { HeuristicLlm } from '../src/llm.ts';
import { fixedClock } from '../src/time.ts';
import { adminClient, freshDb } from './helpers.ts';

export const nw = buildNorthwind();
export const NOW = ANCHOR + 3600e3;

/** Seeds Northwind once per test file; each test gets its own GRAPH.COPY. */
export async function northwindBase(tag: string): Promise<string> {
  const db = await freshDb(`${tag}-base`, 32);
  await seedGraph(db, nw, { embedder: new HashEmbedder(32), now: ANCHOR, skipSchema: true });
  return db.graphName;
}

let n = 0;
export async function ctxOn(base: string, now = NOW): Promise<EngineCtx> {
  const admin = await adminClient();
  const name = `${base}-c${++n}`;
  await copyGraph(admin, base, name);
  return {
    db: new Db(admin, name),
    llm: new HeuristicLlm(nw.accounts.map((a) => a.name)),
    embedder: new HashEmbedder(32),
    clock: fixedClock(now),
  };
}

const agentFor = (ch: string) =>
  ch.includes('deal') ? 'a-renewals' : ch.includes('billing') ? 'a-billing' : 'a-support';
export const inbox = (id: string): DecideRequest => {
  const item = nw.inbox.find((i) => i.id === id)!;
  return { principal: { kind: 'agent', id: agentFor(item.channel) }, text: item.text, channel: item.channel };
};
