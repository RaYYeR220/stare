import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { applySchema, connect, Db, HashEmbedder, loadFlex, loadUdf, verifyLedger } from '@stare/core';
import { CachedEmbedder, modelsFromEnv } from '@stare/llm';
import { buildGlobex } from './globex.ts';
import { seedGraph } from './load.ts';
import { buildNorthwind } from './northwind/index.ts';

export const EMBED_CACHE = fileURLToPath(new URL('../data/embeddings.json', import.meta.url));

/**
 * Seed a tenant graph.
 *   pnpm seed northwind stare:tpl:northwind          # uses the shipped embedding cache
 *   pnpm seed northwind stare:tpl:northwind --fill   # fills the cache from the embedding model
 *   pnpm seed northwind stare:test --hash            # offline hashed embeddings
 */
async function main() {
  const [tenant = 'northwind', graph = `stare:tpl:${tenant}`, ...flags] = process.argv.slice(2);
  const data = tenant === 'globex' ? buildGlobex() : buildNorthwind();
  const admin = await connect({ url: process.env.FALKORDB_URL ?? 'falkor://127.0.0.1:6390', username: process.env.FALKORDB_ADMIN_USER, password: process.env.FALKORDB_ADMIN_PASSWORD });
  await loadUdf(admin);
  await loadFlex(admin);
  if ((await admin.list()).includes(graph)) {
    if (!flags.includes('--force')) {
      console.log(`${graph} exists; pass --force to rebuild`);
      await admin.close();
      return;
    }
    await admin.selectGraph(graph).delete();
  }
  const models = modelsFromEnv();
  const embedder = flags.includes('--hash')
    ? new HashEmbedder(512)
    : new CachedEmbedder(flags.includes('--fill') && !models.offline ? models.embedder : null, EMBED_CACHE, models.offline ? 'text-embedding-qwen3-0-6b' : undefined, models.offline ? 512 : undefined);
  const db = new Db(admin, graph);
  await applySchema(db, embedder.dim);
  const t0 = Date.now();
  await seedGraph(db, data, { embedder, skipSchema: true, log: (m) => process.stdout.write(`${m} `) });
  if (embedder instanceof CachedEmbedder) embedder.save();
  const v = await verifyLedger(db, { deep: true });
  console.log(`\n${graph}: ${data.decisions.length} decisions, ledger ${v.ok ? 'ok' : 'BROKEN'} (${v.length}), ${Date.now() - t0}ms`);
  await admin.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
