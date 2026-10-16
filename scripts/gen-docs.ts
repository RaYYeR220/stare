/** Writes docs/queries.md from the named-query catalogs: every Cypher statement the product runs. */
import { writeFileSync } from 'node:fs';
import {
  ALGO_QUERIES,
  APPROVE_QUERIES,
  ENGINE_QUERIES,
  ERASURE_QUERIES,
  IMPACT_QUERIES,
  MEMORY_QUERIES,
  type NamedQuery,
  Q_LEDGER_APPEND_STANDALONE,
  Q_LEDGER_DECISIONS,
  Q_LEDGER_ENTRIES,
  Q_LEDGER_INIT,
  RACE_QUERIES,
  RULE_QUERIES,
} from '../packages/core/src/index.ts';
import { VIEW_QUERIES } from '../packages/server/src/views.ts';

const sections: [string, string, Record<string, NamedQuery>][] = [
  [
    'Decision engine',
    'How a request becomes approved, countered, escalated, denied or refused.',
    ENGINE_QUERIES,
  ],
  [
    'Human rulings',
    'A person rules on an escalation; authority is re-checked inside the write.',
    APPROVE_QUERIES,
  ],
  [
    'Standing rules',
    'Procedural memory: good-law precedent becomes a ratified rule, quarantined when its basis falls.',
    RULE_QUERIES,
  ],
  [
    'Knowledge currency',
    'Policy changes, departures and reversals, and their effect on precedent.',
    IMPACT_QUERIES,
  ],
  ['Forget with proof', 'Erasure cascade and the four certificate checks.', ERASURE_QUERIES],
  [
    'Graph algorithms as tools',
    'PageRank, betweenness, label propagation and WCC over the decision graph.',
    ALGO_QUERIES,
  ],
  ['Agent memory', 'Episodic and semantic memory, handoffs.', MEMORY_QUERIES],
  ['Concurrency', 'The 64-request burst and its invariants.', RACE_QUERIES],
  [
    'Ledger',
    'The hash chain (hashes computed in-database with stare.sha256).',
    {
      init: Q_LEDGER_INIT,
      append: Q_LEDGER_APPEND_STANDALONE,
      entries: Q_LEDGER_ENTRIES,
      decisions: Q_LEDGER_DECISIONS,
    },
  ],
  ['Desk read models', 'What the web console shows.', VIEW_QUERIES as unknown as Record<string, NamedQuery>],
];

const out = [
  '# Every Cypher query Stare runs',
  '',
  'Generated from the query catalogs in the source (`pnpm docs`). The model never writes Cypher: each query below is fixed, named, parameterised, and shown by name in the "Cypher that ran" panel of every decision. `stare.*` functions are the FalkorDB UDF library in `packages/core/src/udf/stare.js`; `flex.*` is FalkorDB FLEX; `algo.*` are FalkorDB built-in algorithms.',
  '',
  ...sections.flatMap(([title, intro, qs]) => [
    `## ${title}`,
    '',
    intro,
    '',
    ...Object.values(qs).flatMap((q) => [
      `### \`${q.name}\` (${q.mode === 'ro' ? 'read' : 'write'})`,
      '',
      q.doc,
      '',
      '```cypher',
      q.cypher.trim(),
      '```',
      '',
    ]),
  ]),
];
writeFileSync(new URL('../docs/queries.md', import.meta.url), `${out.join('\n')}\n`);
console.log('docs/queries.md written');
