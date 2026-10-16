import { beforeAll, describe, expect, it } from 'vitest';
import { HashEmbedder, verifyLedger, type Db } from '@stare/core';
import { freshDb } from '../../core/test/helpers.ts';
import { ANCHOR, buildGlobex, buildNorthwind, seedGraph, World } from '../src/index.ts';

const nw = buildNorthwind();
let db: Db;

beforeAll(async () => {
  db = await freshDb('seed', 32);
  await seedGraph(db, nw, { embedder: new HashEmbedder(32), now: ANCHOR, skipSchema: true });
}, 120_000);

describe('Northwind build', () => {
  it('is deterministic', () => {
    const again = buildNorthwind();
    expect(JSON.stringify(again.decisions)).toBe(JSON.stringify(nw.decisions));
    expect(JSON.stringify(again.spans)).toBe(JSON.stringify(nw.spans));
  });

  it('has the sizes the spec promises', () => {
    expect(nw.people.length).toBeGreaterThanOrEqual(40);
    expect(nw.accounts.length).toBe(60);
    expect(nw.decisions.length).toBeGreaterThanOrEqual(120);
    expect(nw.decisions.length).toBeLessThanOrEqual(220);
    expect(nw.versions.length).toBe(7);
  });

  it('every generated decision was legitimate when made (except the scripted bad ones)', () => {
    const world = new World(nw.holds, nw.grants, nw.owns, nw.delegations, nw.versions, nw.clauses);
    const byId = new Map(nw.decisions.map((d) => [d.id, d]));
    const overturnsOf = new Map<string, typeof nw.decisions>();
    for (const d of nw.decisions) if (d.overturns) overturnsOf.set(d.overturns.id, [...(overturnsOf.get(d.overturns.id) ?? []), d]);
    const bad = new Set([nw.story.unauthorized, nw.story.conflict]);
    for (const d of nw.decisions) {
      if (bad.has(d.id)) continue;
      const s = world.standing(d.id, d.at + 1, byId, overturnsOf);
      expect.soft(s.codes.filter((c) => c === 'NO_AUTHORITY' || c === 'CONFLICT'), d.id).toEqual([]);
    }
  });
});

describe('seeded graph', () => {
  const flag = async (id: string) =>
    (await db.ro<{ s: { flag: string; reasons: { code: string }[] } }>('MATCH (d:Decision {id:$id}) RETURN stare.standing(d, $now) AS s', { id, now: ANCHOR }))[0]!.s;

  it('story decisions carry the intended good-law flags in the database', async () => {
    expect((await flag(nw.story.unauthorized!)).reasons[0]!.code).toBe('NO_AUTHORITY');
    expect((await flag(nw.story.overturned!)).reasons[0]!.code).toBe('OVERTURNED');
    expect((await flag(nw.story.restsOnUnauthorized!)).flag).toBe('yellow');
    expect((await flag(nw.story.citesOverturned!)).flag).toBe('yellow');
    expect((await flag(nw.story.citesOverturned2!)).flag).toBe('yellow');
    expect((await flag(nw.story.conflict!)).reasons.map((r) => r.code)).toContain('CONFLICT');
    expect((await flag(nw.story.departedApprover!)).flag).toBe('green');
    expect((await flag(nw.story.agentOnDepartedDelegation!)).flag).toBe('green');
    expect((await flag(nw.story.goodLawOutage!)).flag).toBe('green');
    expect((await flag(nw.story.supersededDiscount!)).reasons[0]!.code).toBe('SUPERSEDED');
    expect((await flag(nw.story.supersededTerms!)).reasons[0]!.code).toBe('SUPERSEDED');
    expect((await flag(nw.story.goodwill!)).reasons.map((r) => r.code)).toContain('SUPERSEDED');
  });

  it('the database UDF and the independent TypeScript mirror agree on every decision', async () => {
    const world = new World(nw.holds, nw.grants, nw.owns, nw.delegations, nw.versions, nw.clauses);
    const byId = new Map(nw.decisions.map((d) => [d.id, d]));
    const overturnsOf = new Map<string, typeof nw.decisions>();
    for (const d of nw.decisions) if (d.overturns) overturnsOf.set(d.overturns.id, [...(overturnsOf.get(d.overturns.id) ?? []), d]);
    const [row] = await db.ro<{ r: { id: string; flag: string }[] }>('MATCH (d:Decision) WITH collect(d) AS ds RETURN stare.standingMany(ds, $now) AS r', { now: ANCHOR });
    const memo = new Map();
    let n = 0;
    for (const x of row!.r) {
      expect.soft(x.flag, x.id).toBe(world.standing(x.id, ANCHOR, byId, overturnsOf, memo).flag);
      n++;
    }
    expect(n).toBe(nw.decisions.length);
  });

  it('the seeded ledger verifies end to end, deep', async () => {
    const v = await verifyLedger(db, { deep: true });
    expect(v).toMatchObject({ ok: true, decisionsChecked: nw.decisions.length });
  });

  it('the flag mix is realistic', async () => {
    const [row] = await db.ro<{ r: { flag: string }[] }>('MATCH (d:Decision) WITH collect(d) AS ds RETURN stare.standingMany(ds, $now) AS r', { now: ANCHOR });
    const count = (f: string) => row!.r.filter((x) => x.flag === f).length;
    expect(count('red')).toBeGreaterThanOrEqual(10);
    expect(count('yellow')).toBeGreaterThanOrEqual(3);
    expect(count('green')).toBeGreaterThan(row!.r.length * 0.6);
  });
});

describe('Globex', () => {
  it('builds and seeds as its own graph', async () => {
    const g = buildGlobex();
    const gdb = await freshDb('globex', 32);
    await seedGraph(gdb, g, { embedder: new HashEmbedder(32), now: ANCHOR, skipSchema: true });
    const [row] = await gdb.ro<{ n: number }>('MATCH (d:Decision) RETURN count(d) AS n');
    expect(row!.n).toBe(g.decisions.length);
    expect((await verifyLedger(gdb, { deep: true })).ok).toBe(true);
  });
});
