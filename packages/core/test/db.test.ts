import { describe, expect, it } from 'vitest';
import { freshDb } from './helpers.ts';

describe('Db', () => {
  it('returns typed rows, stats, and records named queries', async () => {
    const db = await freshDb('db', false);
    const q = { name: 'mk', mode: 'rw' as const, cypher: 'CREATE (n:T {v:$v}) RETURN n.v AS v', doc: 'test' };
    const { rows, stats } = await db.rw<{ v: number }>(q, { v: 7 });
    expect(rows).toEqual([{ v: 7 }]);
    expect(stats['Nodes created']).toBe('1');
    const back = await db.ro<{ v: number }>('MATCH (n:T) RETURN n.v AS v');
    expect(back[0]?.v).toBe(7);
    expect(db.recorder?.entries.map((e) => e.name).slice(-2)).toEqual(['mk', 'adhoc']);
    expect(db.recorder?.entries.at(-2)?.cypher).toContain('CREATE');
  });

  it('refuses to run a write query through ro()', async () => {
    const db = await freshDb('db2', false);
    await expect(db.ro({ name: 'x', mode: 'rw', cypher: 'CREATE ()', doc: '' })).rejects.toThrow(
      /not read-only/,
    );
  });

  it('passes list and nested params', async () => {
    const db = await freshDb('db3', false);
    const rows = await db.ro<{ n: number; s: string }>('RETURN size($xs) AS n, $m.k AS s', {
      xs: [1, 2, 3],
      m: { k: 'ok' },
    });
    expect(rows[0]).toEqual({ n: 3, s: 'ok' });
  });
});
