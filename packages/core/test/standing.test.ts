import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.ts';
import { baseWorld, d, decision, standing } from './fixtures.ts';
import { freshDb } from './helpers.ts';

let db: Db;
beforeEach(async () => {
  db = await freshDb('standing');
  await baseWorld(db);
});

const NOW = d(200);

describe('stare.standing — good law', () => {
  it('green: authorized human approval within cap under a version whose limits it still meets', async () => {
    await decision(db, { id: 'D1', at: d(10), value: 800, madeBy: 'ana', facts: { days: 45 } });
    expect(await standing(db, 'D1', NOW)).toEqual({ flag: 'green', reasons: [], chain: [] });
  });

  it('red OVERTURNED once a later decision reverses it (not before)', async () => {
    await decision(db, { id: 'D1', at: d(10), value: 800, madeBy: 'ana', facts: { days: 45 } });
    await decision(db, { id: 'R1', at: d(60), value: 0, madeBy: 'oli', outcome: 'denied' });
    await db.rw(
      `MATCH (r:Decision {id:'R1'}), (x:Decision {id:'D1'}) CREATE (r)-[:OVERTURNS {reason:'clawback after audit', at:$at}]->(x)`,
      { at: d(60) },
    );
    expect((await standing(db, 'D1', d(59))).flag).toBe('green');
    const s = await standing(db, 'D1', NOW);
    expect(s.flag).toBe('red');
    expect(s.reasons[0]).toMatchObject({ code: 'OVERTURNED', detail: 'clawback after audit', nodeId: 'R1' });
  });

  it('red NO_AUTHORITY when the approver cap was below the value at the time', async () => {
    await decision(db, { id: 'D1', at: d(10), value: 2400, madeBy: 'ana', facts: { days: 45 } });
    const s = await standing(db, 'D1', NOW);
    expect(s.flag).toBe('red');
    expect(s.reasons[0]).toMatchObject({ code: 'NO_AUTHORITY', nodeId: 'ana' });
    expect(s.reasons[0]!.detail).toContain('1000');
  });

  it('red NO_AUTHORITY when the role was only granted after the decision', async () => {
    await decision(db, { id: 'D1', at: d(20), value: 600, madeBy: 'sam', facts: { days: 45 } });
    const s = await standing(db, 'D1', NOW);
    expect(s.flag).toBe('red');
    expect(s.reasons[0]!.detail).toContain('no approving role');
  });

  it('red CONFLICT when the approver owned the account', async () => {
    await decision(db, { id: 'D1', at: d(10), value: 900, madeBy: 'oli', facts: { days: 45 } });
    const s = await standing(db, 'D1', NOW);
    expect(s.flag).toBe('red');
    expect(s.reasons.map((r) => r.code)).toEqual(['CONFLICT']);
  });

  it('green: approver who left later does not invalidate the decision (authority at time)', async () => {
    await decision(db, { id: 'D1', at: d(30), value: 3000, madeBy: 'vic', facts: { days: 50 } });
    expect((await standing(db, 'D1', NOW)).flag).toBe('green');
  });

  it('red SUPERSEDED when the current version forbids what it granted; green under its own version', async () => {
    await decision(db, { id: 'D1', at: d(30), value: 900, madeBy: 'ana', facts: { days: 90 } });
    expect((await standing(db, 'D1', d(99))).flag).toBe('green');
    const s = await standing(db, 'D1', NOW);
    expect(s.flag).toBe('red');
    expect(s.reasons[0]).toMatchObject({ code: 'SUPERSEDED', nodeId: 'v3-4.5' });
  });

  it('green: decision made under the current version is never superseded by it', async () => {
    await decision(db, { id: 'D1', at: d(120), value: 900, madeBy: 'ana', version: 'refunds-v3', facts: { days: 55 } });
    expect((await standing(db, 'D1', NOW)).flag).toBe('green');
  });

  it('agent decision: green under live delegation; red when the delegation cap was too low', async () => {
    await decision(db, { id: 'A1', at: d(10), value: 700, madeBy: 'support-agent', onAuthorityOf: 'ana', basis: 'precedent', facts: { days: 45 } });
    await decision(db, { id: 'A2', at: d(10), value: 1500, madeBy: 'support-agent', onAuthorityOf: 'ana', basis: 'precedent', facts: { days: 45 } });
    await decision(db, { id: 'A3', at: d(10), value: 300, madeBy: 'support-agent', basis: 'precedent', facts: { days: 45 } });
    expect((await standing(db, 'A1', NOW)).flag).toBe('green');
    const s2 = await standing(db, 'A2', NOW);
    expect(s2.flag).toBe('red');
    expect(s2.reasons[0]!.detail).toContain('delegation cap 1000');
    expect((await standing(db, 'A3', NOW)).reasons[0]!.detail).toContain('without a delegating person');
  });

  it('yellow RESTS_ON_RED transitively, with the chain to the red root', async () => {
    await decision(db, { id: 'P0', at: d(5), value: 2400, madeBy: 'ana', facts: { days: 45 } }); // red: over cap
    await decision(db, { id: 'P1', at: d(10), value: 800, madeBy: 'ana', cites: ['P0'], facts: { days: 45 } });
    await decision(db, { id: 'P2', at: d(20), value: 800, madeBy: 'ana', cites: ['P1'], facts: { days: 45 } });
    const s1 = await standing(db, 'P1', NOW);
    expect(s1).toMatchObject({ flag: 'yellow', chain: ['P0'] });
    const s2 = await standing(db, 'P2', NOW);
    expect(s2.flag).toBe('yellow');
    expect(s2.chain).toEqual(['P1', 'P0']);
    expect(s2.reasons[0]!.code).toBe('RESTS_ON_RED');
  });

  it('terminates on citation cycles and fails closed (yellow UNVERIFIABLE, never green)', async () => {
    await decision(db, { id: 'C1', at: d(10), value: 800, madeBy: 'ana', facts: { days: 45 } });
    await decision(db, { id: 'C2', at: d(11), value: 800, madeBy: 'ana', cites: ['C1'], facts: { days: 45 } });
    await db.rw(`MATCH (a:Decision {id:'C2'}), (b:Decision {id:'C1'}) CREATE (a)-[:PRECEDENT_FOR]->(b)`);
    const s = await standing(db, 'C1', NOW);
    expect(s.flag).toBe('yellow');
    expect(s.chain).toEqual(['C2', 'C1']);
  });

  it('fails closed on a citation chain deeper than the cap', async () => {
    await decision(db, { id: 'K0', at: d(1), value: 800, madeBy: 'ana', facts: { days: 45 } });
    for (let i = 1; i <= 14; i++) {
      await decision(db, { id: `K${i}`, at: d(1 + i), value: 800, madeBy: 'ana', cites: [`K${i - 1}`], facts: { days: 45 } });
    }
    const s = await standing(db, 'K14', NOW);
    expect(s.flag).toBe('yellow');
  });

  it('a mislabelled exception (basis routine but outside the envelope) still needs authority', async () => {
    await decision(db, { id: 'M1', at: d(10), value: 2400, madeBy: 'ana', basis: 'routine', facts: { days: 45 } });
    expect((await standing(db, 'M1', NOW)).reasons[0]!.code).toBe('NO_AUTHORITY');
  });

  it('routine-ness is judged on the granted value, not on a value claimed in the facts JSON', async () => {
    await decision(db, { id: 'F1', at: d(10), value: 2400, madeBy: 'ana', basis: 'routine', facts: { days: 10, value: 200 } });
    expect((await standing(db, 'F1', NOW)).reasons[0]!.code).toBe('NO_AUTHORITY');
  });

  it('a truly routine decision needs no approving role', async () => {
    await decision(db, { id: 'R1', at: d(10), value: 200, madeBy: 'sam', basis: 'routine', facts: { days: 10 } });
    expect((await standing(db, 'R1', NOW)).flag).toBe('green');
  });

  it('red when no policy version is in force or none was recorded', async () => {
    await decision(db, { id: 'N1', at: d(10), value: 800, madeBy: 'ana', facts: { days: 45 } });
    await db.rw(`MATCH (:Decision {id:'N1'})-[r:APPLIED_POLICY]->() DELETE r`);
    expect((await standing(db, 'N1', NOW)).reasons[0]!.detail).toBe('no policy version recorded');
  });

  it('standingMany flags a batch with a shared memo', async () => {
    await decision(db, { id: 'P0', at: d(5), value: 2400, madeBy: 'ana', facts: { days: 45 } });
    await decision(db, { id: 'P1', at: d(10), value: 800, madeBy: 'ana', cites: ['P0'], facts: { days: 45 } });
    const [row] = await db.ro<{ r: { id: string; flag: string }[] }>(
      'MATCH (x:Decision) WITH collect(x) AS xs RETURN stare.standingMany(xs, $now) AS r',
      { now: NOW },
    );
    const byId = Object.fromEntries(row!.r.map((x) => [x.id, x.flag]));
    expect(byId).toEqual({ P0: 'red', P1: 'yellow' });
  });
});

describe('stare.covers', () => {
  it('covers same reason, smaller-or-equal value, not-smaller tier; partial when only value exceeds', async () => {
    await decision(db, { id: 'P', at: d(10), value: 1200, madeBy: 'ana', facts: { days: 45, tier: 'growth' } });
    const run = async (facts: object) =>
      (await db.ro<{ c: any }>(`MATCH (p:Decision {id:'P'}) RETURN stare.covers(p, $f) AS c`, { f: JSON.stringify(facts) }))[0]!.c;
    const base = { policyId: 'refunds', reason: 'outage', tier: 'growth', days: 40 };
    expect(await run({ ...base, value: 1000 })).toMatchObject({ covers: true, partial: false });
    expect(await run({ ...base, value: 1800 })).toMatchObject({ covers: false, partial: true, maxValue: 1200 });
    expect(await run({ ...base, value: 1000, reason: 'goodwill' })).toMatchObject({ covers: false, partial: false });
    expect(await run({ ...base, value: 1000, tier: 'standard' })).toMatchObject({ covers: false });
    expect(await run({ ...base, value: 1000, tier: 'enterprise' })).toMatchObject({ covers: true });
    expect(await run({ ...base, value: 1000, days: 60 })).toMatchObject({ covers: false });
    expect(await run({ ...base, value: 1000, tier: 'platinum' })).toMatchObject({ covers: false, partial: false });
    expect(await run({ policyId: 'refunds', tier: 'growth', days: 40, value: 1000 })).toMatchObject({ covers: false });
    expect(await run({ ...base, value: '1000' })).toMatchObject({ covers: false, partial: false });
    const { days: _drop, ...noDays } = base;
    expect(await run({ ...noDays, value: 1000 })).toMatchObject({ covers: false, partial: false });
  });
});
