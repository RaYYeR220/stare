import { connect } from '../src/db.ts';
import { loadUdf } from '../src/udf/load.ts';

export const TEST_URL = process.env.STARE_TEST_URL ?? 'falkor://127.0.0.1:6390';

export default async function setup() {
  const admin = await connect({ url: TEST_URL });
  await loadUdf(admin, true);
  const graphs = await admin.list();
  for (const g of graphs) if (g.startsWith('stare:test')) await admin.selectGraph(g).delete();
  await admin.close();
}
