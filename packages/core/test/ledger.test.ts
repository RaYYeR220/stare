import { describe, expect, it } from 'vitest';
import { connect, Db } from '../src/db.ts';
import {
  canonicalJson,
  LEDGER_HEAD,
  ledgerParams,
  ledgerWrite,
  Q_LEDGER_APPEND_STANDALONE,
  Q_LEDGER_INIT,
  verifyLedger,
} from '../src/ledger.ts';
import { freshDb, TEST_URL } from './helpers.ts';

describe('ledger', () => {
  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('appends in-database, verifies client-side, detects tampering', async () => {
    const db = await freshDb('ledger');
    await db.rw(Q_LEDGER_INIT);
    for (let i = 0; i < 3; i++)
      await db.rw(Q_LEDGER_APPEND_STANDALONE, ledgerParams('decision', `D${i}`, 1000 + i, { value: i }));
    expect(await verifyLedger(db)).toMatchObject({ ok: true, length: 3 });
    await db.rw(`MATCH (e:LedgerEntry {seq:2}) SET e.payload = replace(e.payload, '"value":1', '"value":9')`);
    expect(await verifyLedger(db)).toMatchObject({
      ok: false,
      brokenAt: 2,
      reason: 'payload does not match its hash',
    });
  });

  it('fails closed without a ledger head: nothing is written', async () => {
    const db = await freshDb('ledger-nohead');
    const { stats } = await db.rw(
      `${LEDGER_HEAD} CREATE (d:Decision {id:'X', caseId:'X'}) ${ledgerWrite(['d'])} RETURN d.id AS id`,
      ledgerParams('decision', 'X', 1, {}),
    );
    expect(stats['Nodes created']).toBeUndefined();
    expect(await db.ro('MATCH (d:Decision) RETURN d')).toEqual([]);
  });

  it('deep check catches a decision edited after the fact, and one written outside the ledger', async () => {
    const db = await freshDb('ledger-deep');
    await db.rw(Q_LEDGER_INIT);
    await db.rw(`CREATE (:Agent {id:'ag'})`);
    const payload = {
      caseId: 'C1',
      outcome: 'approved',
      value: 900,
      basis: 'precedent',
      policyVersionId: 'refunds-v3',
      madeBy: 'ag',
      at: 5,
    };
    await db.rw(
      `${LEDGER_HEAD} MATCH (ag:Agent {id:'ag'})
       CREATE (d:Decision {id:'D1', caseId:'C1', outcome:'approved', value:900, basis:'precedent', policyVersionId:'refunds-v3', at:5})-[:MADE_BY]->(ag)
       ${ledgerWrite(['d'])} RETURN d.id AS id`,
      ledgerParams('decision', 'D1', 5, payload),
    );
    expect(await verifyLedger(db, { deep: true })).toMatchObject({ ok: true, decisionsChecked: 1 });
    await db.rw(`MATCH (d:Decision {id:'D1'}) SET d.value = 9000`);
    const v = await verifyLedger(db, { deep: true });
    expect(v.ok).toBe(false);
    expect(v.mismatched).toEqual([{ id: 'D1', field: 'value', ledger: 900, live: 9000 }]);
    await db.rw(`CREATE (:Decision {id:'D2', caseId:'C2'})`);
    expect((await verifyLedger(db, { deep: true })).unrecorded).toEqual(['D2']);
    await db.rw(`MATCH (d:Decision) DETACH DELETE d`);
    expect(await verifyLedger(db, { deep: true })).toMatchObject({
      ok: false,
      vanished: ['D1'],
      reason: 'recorded decisions no longer exist',
    });
  });

  it('rejects an entry whose unhashed refId was repointed, and a missing head', async () => {
    const db = await freshDb('ledger-refid');
    await db.rw(Q_LEDGER_INIT);
    await db.rw(Q_LEDGER_APPEND_STANDALONE, ledgerParams('decision', 'D1', 1, {}));
    await db.rw(`MATCH (e:LedgerEntry {seq:1}) SET e.refId = 'D9'`);
    expect((await verifyLedger(db)).reason).toBe('entry kind/refId differ from the hashed payload');
    await db.rw(`MATCH (e:LedgerEntry {seq:1}) SET e.refId = 'D1'`);
    await db.rw(`MATCH (h:LedgerHead) DELETE h`);
    expect((await verifyLedger(db)).reason).toBe('ledger head missing');
  });

  it('64 concurrent appends from 16 connections never fork', async () => {
    const db = await freshDb('ledger64');
    await db.rw(Q_LEDGER_INIT);
    const clients = await Promise.all(Array.from({ length: 16 }, () => connect({ url: TEST_URL })));
    await Promise.all(
      Array.from({ length: 64 }, (_, i) =>
        new Db(clients[i % 16]!, db.graphName).rw(
          Q_LEDGER_APPEND_STANDALONE,
          ledgerParams('decision', `C${i}`, i, { i }),
        ),
      ),
    );
    await Promise.all(clients.map((c) => c.close()));
    expect(await verifyLedger(db)).toMatchObject({ ok: true, length: 64 });
  });
});
