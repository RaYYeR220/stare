import type { Db } from './db.ts';

export const EMBED_DIM_DEFAULT = 512;

/** Labels looked up by `id`. Each gets an exact-match range index. */
const ID_LABELS = [
  'Person', 'Team', 'Role', 'Agent', 'Account', 'Contact', 'Salt', 'Source', 'Span', 'Fact', 'Ticket', 'Incident',
  'Policy', 'PolicyVersion', 'Clause', 'Case', 'Decision', 'Escalation', 'Budget', 'Reason', 'LedgerHead',
  'LedgerEntry', 'Episode', 'StandingRule', 'Handoff', 'Erasure',
];

const UNIQUE: Array<[string, string]> = [
  ['Decision', 'caseId'],
  ['Case', 'key'],
  ['LedgerEntry', 'seq'],
  ['Account', 'id'],
  ['Person', 'id'],
  ['Agent', 'id'],
];

const VECTOR_LABELS = ['Span', 'Decision', 'Fact', 'Episode'];

async function tryRw(db: Db, cypher: string) {
  try {
    await db.rw(cypher);
  } catch (e) {
    const msg = String((e as Error).message);
    if (!/already (indexed|exists)/i.test(msg)) throw e;
  }
}

/** Idempotent: indexes, constraints and vector indexes for one tenant graph. */
export async function applySchema(db: Db, embedDim = EMBED_DIM_DEFAULT): Promise<void> {
  for (const l of ID_LABELS) await tryRw(db, `CREATE INDEX FOR (n:${l}) ON (n.id)`);
  await tryRw(db, 'CREATE INDEX FOR (n:Decision) ON (n.caseId)');
  await tryRw(db, 'CREATE INDEX FOR (n:Decision) ON (n.policyId)');
  await tryRw(db, 'CREATE INDEX FOR (n:Case) ON (n.key)');
  await tryRw(db, 'CREATE INDEX FOR (n:LedgerEntry) ON (n.seq)');
  await tryRw(db, 'CREATE INDEX FOR (n:Reason) ON (n.code)');
  for (const l of VECTOR_LABELS) {
    await tryRw(
      db,
      `CREATE VECTOR INDEX FOR (n:${l}) ON (n.embedding) OPTIONS {dimension:${embedDim}, similarityFunction:'cosine'}`,
    );
  }
  for (const [label, prop] of UNIQUE) {
    try {
      await db.graph.constraintCreate('UNIQUE' as any, 'NODE' as any, label, prop);
    } catch (e) {
      if (!/already exists/i.test(String((e as Error).message))) throw e;
    }
  }
  await waitConstraints(db);
}

async function waitConstraints(db: Db) {
  for (let i = 0; i < 100; i++) {
    const rows = await db.ro<{ status: string }>('CALL db.constraints() YIELD status RETURN status');
    if (rows.every((r) => r.status === 'OPERATIONAL')) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('constraints did not become operational');
}
