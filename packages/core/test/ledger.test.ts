import { describe, expect, it } from 'vitest';
import { canonicalJson, ledgerParams, Q_LEDGER_APPEND_STANDALONE, Q_LEDGER_INIT, verifyLedger } from '../src/ledger.ts';
import { connect, Db } from '../src/db.ts';
import { freshDb, TEST_URL } from './helpers.ts';

describe('ledger', () => {
  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('appends in-database, verifies client-side, detects tampering', async () => {
    const db = await freshDb('ledger');
    await db.rw(Q_LEDGER_INIT);
    for (let i = 0; i < 3; i++) await db.rw(Q_LEDGER_APPEND_STANDALONE, ledgerParams('decision', `D${i}`, 1000 + i, { value: i }));
    expect(await verifyLedger(db)).toMatchObject({ ok: true, length: 3 });
    await db.rw(`MATCH (e:LedgerEntry {seq:2}) SET e.payload = replace(e.payload, '"value":1', '"value":9')`);
    expect(await verifyLedger(db)).toMatchObject({ ok: false, brokenAt: 2, reason: 'payload does not match its hash' });
  });

  it('64 concurrent appends from 16 connections never fork', async () => {
    const db = await freshDb('ledger64');
    await db.rw(Q_LEDGER_INIT);
    const clients = await Promise.all(Array.from({ length: 16 }, () => connect({ url: TEST_URL })));
    await Promise.all(
      Array.from({ length: 64 }, (_, i) =>
        new Db(clients[i % 16]!, db.graphName).rw(Q_LEDGER_APPEND_STANDALONE, ledgerParams('decision', `C${i}`, i, { i })),
      ),
    );
    await Promise.all(clients.map((c) => c.close()));
    expect(await verifyLedger(db)).toMatchObject({ ok: true, length: 64 });
  });
});
