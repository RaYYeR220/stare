import { connect, Db } from '../src/db.ts';
import { applySchema } from '../src/schema.ts';
import { loadFlex } from '../src/udf/flex.ts';
import { loadUdf } from '../src/udf/load.ts';

export const TEST_URL = process.env.STARE_TEST_URL ?? 'falkor://127.0.0.1:6390';

/**
 * Schema templates are built once, serially. Test files then GRAPH.COPY them.
 * (FalkorDB 4.22.1 can crash when indexes/constraints are created concurrently on several graphs.)
 */
export default async function setup() {
  const admin = await connect({ url: TEST_URL });
  await loadUdf(admin, true);
  await loadFlex(admin);
  const graphs = await admin.list();
  for (const g of graphs) if (g.startsWith('stare:test')) await admin.selectGraph(g).delete();
  for (const dim of [4, 32]) await applySchema(new Db(admin, `stare:test-template-${dim}`), dim);
  await admin.close();
}
