import 'dotenv/config';
import { HeuristicLlm, POLICY_IDS, REASONS } from '../packages/core/src/index.ts';
import { VeniceClient, VeniceLlm } from '../packages/llm/src/index.ts';
import { buildNorthwind } from '../packages/seed/src/index.ts';

const nw = buildNorthwind();
const client = new VeniceClient(process.env.VENICE_API_KEY!);
const heur = new HeuristicLlm(nw.accounts.map((a) => a.name));
const hints = { policies: POLICY_IDS, reasons: REASONS };
const models = process.argv.slice(2);
const gold = await Promise.all(nw.inbox.map((i) => heur.parseRequest(i.text, hints)));
for (const m of models) {
  const llm = new VeniceLlm(client, m);
  let ok = 0, claims = 0; const t0 = Date.now(); const diffs: string[] = [];
  for (let i = 0; i < nw.inbox.length; i++) {
    try {
      const r = await llm.parseRequest(nw.inbox[i]!.text, hints);
      const g = gold[i]!;
      const same = r.policyId === g.policyId && r.value === g.value && r.days === g.days && r.reason === g.reason && (r.accountName ?? '').toLowerCase() === (g.accountName ?? '').toLowerCase();
      if (same) ok++; else diffs.push(`${nw.inbox[i]!.id}: got ${JSON.stringify([r.policyId, r.accountName, r.value, r.days, r.reason])} vs ${JSON.stringify([g.policyId, g.accountName, g.value, g.days, g.reason])}`);
      if (r.claims.length) claims++;
    } catch (e) { diffs.push(`${nw.inbox[i]!.id}: ERR ${(e as Error).message.slice(0, 120)}`); }
  }
  console.log(`\n== ${m}: ${ok}/${nw.inbox.length} match heuristic, claims flagged on ${claims}, ${Date.now() - t0}ms`);
  for (const d of diffs) console.log('  ', d);
}
