import { randomBytes } from 'node:crypto';
import type { FalkorDB } from 'falkordb';
import { copyGraph } from '../src/copy.ts';
import { connect, Db, QueryRecorder } from '../src/db.ts';

export const TEST_URL = process.env.STARE_TEST_URL ?? 'falkor://127.0.0.1:6390';

let shared: FalkorDB | undefined;
export async function adminClient(): Promise<FalkorDB> {
  shared ??= await connect({ url: TEST_URL });
  return shared;
}

/** A fresh graph for one test: a GRAPH.COPY of the schema template (or an empty graph). */
export async function freshDb(tag: string, schema: boolean | 4 | 32 = true): Promise<Db> {
  const client = await adminClient();
  const name = `stare:test-${tag}-${randomBytes(3).toString('hex')}`;
  if (schema) await copyGraph(client, `stare:test-template-${schema === true ? 4 : schema}`, name);
  const db = new Db(client, name, new QueryRecorder());
  if (!schema) await db.rw('CREATE (n:Init) DELETE n');
  return db;
}
