import { ANCHOR, buildNorthwind, World } from '../packages/seed/src/index.ts';

const nw = buildNorthwind();
const w = new World(nw.holds, nw.grants, nw.owns, nw.delegations, nw.versions, nw.clauses);
const byId = new Map(nw.decisions.map((d) => [d.id, d]));
const ov = new Map<string, (typeof nw.decisions)[number][]>();
for (const d of nw.decisions) if (d.overturns) ov.set(d.overturns.id, [...(ov.get(d.overturns.id) ?? []), d]);
const memo = new Map();
const flags: Record<string, number> = {};
const codes: Record<string, number> = {};
for (const d of nw.decisions) {
  const s = w.standing(d.id, ANCHOR, byId, ov, memo);
  flags[s.flag] = (flags[s.flag] ?? 0) + 1;
  for (const c of s.codes) codes[c] = (codes[c] ?? 0) + 1;
}
const by = (k: (d: (typeof nw.decisions)[number]) => string) =>
  nw.decisions.reduce<Record<string, number>>((m, d) => ((m[k(d)] = (m[k(d)] ?? 0) + 1), m), {});
console.log({ decisions: nw.decisions.length, cases: nw.cases.length, spans: nw.spans.length, facts: nw.facts.length, episodes: nw.episodes.length, escalations: nw.escalations.length, contacts: nw.contacts.length });
console.log('flags', flags, 'codes', codes);
console.log('policy', by((d) => d.policyId), 'basis', by((d) => d.basis), 'maker', by((d) => (d.madeBy.startsWith('a-') ? d.madeBy : 'human')));
console.log('budgets', nw.budgets.map((b) => `${b.id} ${b.remaining}/${b.cap}`));
