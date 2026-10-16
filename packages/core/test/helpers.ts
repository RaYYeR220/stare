import { randomBytes } from 'node:crypto';
import type { FalkorDB } from 'falkordb';
import { connect, Db, QueryRecorder } from '../src/db.ts';
import { applySchema } from '../src/schema.ts';

export const TEST_URL = process.env.STARE_TEST_URL ?? 'falkor://127.0.0.1:6390';

let shared: FalkorDB | undefined;
export async function adminClient(): Promise<FalkorDB> {
  shared ??= await connect({ url: TEST_URL });
  return shared;
}

/** A fresh, schema'd graph for one test file. */
export async function freshDb(tag: string, schema = true): Promise<Db> {
  const client = await adminClient();
  const db = new Db(client, `stare:test-${tag}-${randomBytes(3).toString('hex')}`, new QueryRecorder());
  if (schema) await applySchema(db, 4);
  else await db.rw('CREATE (n:Init) DELETE n');
  return db;
}
