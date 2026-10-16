import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { freshDb } from './helpers.ts';

describe('stare UDF basics', () => {
  it('sha256 matches node crypto byte-for-byte (incl. unicode)', async () => {
    const db = await freshDb('udf', false);
    for (const s of ['', 'abc', 'GENESIS|00ff', 'Zoë — façade ✓', 'x'.repeat(200)]) {
      const [row] = await db.ro<{ h: string }>('RETURN stare.sha256($s) AS h', { s });
      expect(row?.h).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });

  it('violations splits default vs limit clauses', async () => {
    const db = await freshDb('udf2', false);
    await db.rw(`CREATE (pv:PolicyVersion {id:'refunds-v3'}),
      (pv)-[:HAS_CLAUSE]->(:Clause {id:'c1', key:'4.1', kind:'default', rule:'{"field":"days","op":"lte","value":30}'}),
      (pv)-[:HAS_CLAUSE]->(:Clause {id:'c2', key:'4.2', kind:'default', rule:'{"field":"value","op":"lte","value":500}'}),
      (pv)-[:HAS_CLAUSE]->(:Clause {id:'c3', key:'4.5', kind:'limit', rule:'{"field":"value","op":"lte","value":5000}'}),
      (pv)-[:HAS_CLAUSE]->(:Clause {id:'c4', key:'4.6', kind:'limit', rule:'{"field":"accountStatus","op":"neq","value":"collections"}'})`);
    const run = async (facts: object) =>
      (
        await db.ro<{ v: any }>(
          `MATCH (pv:PolicyVersion {id:'refunds-v3'}) RETURN stare.violations($f, pv) AS v`,
          { f: JSON.stringify(facts) },
        )
      )[0]!.v;
    const routine = await run({ days: 10, value: 200, accountStatus: 'active' });
    expect(routine).toEqual({ limit: [], default: [] });
    const exc = await run({ days: 41, value: 1800, accountStatus: 'active' });
    expect(exc.default.map((c: any) => c.key).sort()).toEqual(['4.1', '4.2']);
    expect(exc.limit).toEqual([]);
    const banned = await run({ days: 10, value: 9000, accountStatus: 'collections' });
    expect(banned.limit.map((c: any) => c.key).sort()).toEqual(['4.5', '4.6']);
    // missing facts fail closed
    const missing = await run({ days: 10 });
    expect(missing.limit.map((c: any) => c.key).sort()).toEqual(['4.5', '4.6']);
    expect(missing.default.map((c: any) => c.key)).toEqual(['4.2']);
  });
});

describe('stare.scanTerms', () => {
  it('finds identifiers in node and edge properties (case-insensitive)', async () => {
    const db = await freshDb('scan', false);
    await db.rw(
      `CREATE (:Contact {id:'c1', name:'Marta Lindqvist'})-[:NOTE {text:'call MARTA tomorrow'}]->(:Span {id:'s1', text:'nothing here'})`,
    );
    const [row] = await db.ro<{ h: { kind: string; label: string; id: string; key: string }[] }>(
      "RETURN stare.scanTerms(['marta'], ['Contact', 'Span'], ['NOTE']) AS h",
    );
    expect(row!.h.map((x) => `${x.kind}:${x.label}.${x.key}`).sort()).toEqual([
      'edge:NOTE.text',
      'node:Contact.name',
    ]);
  });
});
