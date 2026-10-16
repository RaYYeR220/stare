import 'dotenv/config';
import { serve } from '@hono/node-server';
import { applySchema, copyGraph, Db, graphOf, loadFlex, loadUdf, provisionTenantUser, templateOf, verifyLedger } from '@stare/core';
import { CachedEmbedder } from '@stare/llm';
import { buildGlobex, buildNorthwind, seedGraph } from '@stare/seed';
import { buildApp } from './app.ts';
import { configFromEnv, Runtime } from './runtime.ts';

const log = (m: string) => console.log(`[stare] ${m}`);

/**
 * Boot: load the UDF libraries, make sure each tenant has a pristine template (seeded from the shipped
 * embedding cache) and a live graph, and give each tenant its own ACL user. Schema work runs serially.
 */
export async function bootstrap(rt: Runtime) {
  await loadUdf(rt.admin);
  await loadFlex(rt.admin);
  const graphs = await rt.admin.list();
  const cache = new CachedEmbedder(null, rt.cfg.embedCache, 'text-embedding-qwen3-0-6b', 512);
  for (const [tenant, build] of [['northwind', buildNorthwind], ['globex', buildGlobex]] as const) {
    const tpl = templateOf(tenant);
    if (!graphs.includes(tpl)) {
      log(`seeding ${tpl}`);
      const db = new Db(rt.admin, tpl);
      await applySchema(db, cache.dim);
      await seedGraph(db, build(), { embedder: cache, skipSchema: true });
      const v = await verifyLedger(db, { deep: true });
      log(`${tpl}: ledger ${v.ok ? 'ok' : 'BROKEN'} (${v.length})`);
    }
    const live = graphOf(tenant);
    if (!graphs.includes(live)) {
      await copyGraph(rt.admin, tpl, live);
      log(`created ${live}`);
    }
    await provisionTenantUser(rt.admin, tenant, { password: process.env[`STARE_${tenant.toUpperCase()}_PASSWORD`] || undefined });
  }
  if (process.env.STARE_AUDITOR_PASSWORD) {
    await provisionTenantUser(rt.admin, 'northwind', { readOnly: true, user: 'auditor', password: process.env.STARE_AUDITOR_PASSWORD });
    log('auditor (read-only) user provisioned for stare:northwind');
  }
}

async function main() {
  const cfg = configFromEnv();
  const rt = new Runtime(cfg);
  await rt.start();
  await bootstrap(rt);
  const app = buildApp(rt, { allowedOrigins: (process.env.STARE_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean) });
  serve({ fetch: app.fetch, port: cfg.port, hostname: process.env.HOST ?? '127.0.0.1' }, (i) => log(`listening on ${i.address}:${i.port} (${rt.models.offline ? 'offline models' : rt.models.llm.model})`));
  const stop = async () => {
    await rt.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1]?.endsWith('main.ts')) await main();
