import { createHash } from 'node:crypto';
import type { Db, NamedQuery } from './db.ts';

export const GENESIS = 'GENESIS';

export type LedgerKind = 'decision' | 'escalation' | 'erasure' | 'policy' | 'rule' | 'overturn' | 'departure';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Deterministic JSON: sorted keys, no whitespace. The ledger hashes exactly this string. */
export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x ?? null);
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(',')}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export interface LedgerParams {
  ledgerKind: LedgerKind;
  ledgerRefId: string;
  ledgerPayload: string;
  ledgerPayloadHash: string;
  ledgerAt: number;
}

/** Parameters for an append; the payload must already be free of personal data (commitments only). */
export function ledgerParams(kind: LedgerKind, refId: string, at: number, payload: Record<string, unknown>): LedgerParams {
  const body = canonicalJson({ kind, refId, at, ...payload });
  return { ledgerKind: kind, ledgerRefId: refId, ledgerPayload: body, ledgerPayloadHash: sha256Hex(body), ledgerAt: at };
}

/**
 * Cypher tail that appends one entry to the hash chain inside the caller's write query.
 * The new hash is computed in the database (stare.sha256), so concurrent writers serialize on the
 * graph's single writer and the chain can never fork. Expects the variables in `carry` to be bound.
 */
export function ledgerAppend(carry: string[] = []): string {
  const keep = carry.length ? `${carry.join(', ')}, ` : '';
  return `
WITH ${keep}1 AS __one
MATCH (lh:LedgerHead {id:'head'})
WITH ${keep}lh, stare.sha256(lh.hash + '|' + $ledgerPayloadHash) AS __nh
CREATE (le:LedgerEntry {seq: lh.seq + 1, kind: $ledgerKind, refId: $ledgerRefId, payload: $ledgerPayload,
                        payloadHash: $ledgerPayloadHash, prev: lh.hash, hash: __nh, at: $ledgerAt})
SET lh.seq = lh.seq + 1, lh.hash = __nh`;
}

export const Q_LEDGER_INIT: NamedQuery = {
  name: 'ledger.init',
  mode: 'rw',
  doc: 'Create the ledger head (genesis) if the graph has none.',
  cypher: `MERGE (lh:LedgerHead {id:'head'}) ON CREATE SET lh.seq = 0, lh.hash = '${GENESIS}' RETURN lh.seq AS seq`,
};

export const Q_LEDGER_ENTRIES: NamedQuery = {
  name: 'ledger.entries',
  mode: 'ro',
  doc: 'Every ledger entry in sequence order, plus the head.',
  cypher: `MATCH (e:LedgerEntry)
WITH e ORDER BY e.seq
WITH collect({seq: e.seq, kind: e.kind, refId: e.refId, payload: e.payload, payloadHash: e.payloadHash, prev: e.prev, hash: e.hash}) AS entries
OPTIONAL MATCH (lh:LedgerHead {id:'head'})
RETURN entries, lh.seq AS headSeq, lh.hash AS headHash`,
};

export const Q_LEDGER_APPEND_STANDALONE: NamedQuery = {
  name: 'ledger.append',
  mode: 'rw',
  doc: 'Append one entry to the hash chain (hash computed in-database with stare.sha256).',
  cypher: `${ledgerAppend()}\nRETURN le.seq AS seq, le.hash AS hash`,
};

export interface LedgerVerdict {
  ok: boolean;
  length: number;
  head: string;
  brokenAt?: number;
  reason?: string;
}

/** Recomputes every link client-side (Node crypto) — independent of the in-database hashing. */
export async function verifyLedger(db: Db): Promise<LedgerVerdict> {
  const [row] = await db.ro<{
    entries: { seq: number; payload: string; payloadHash: string; prev: string; hash: string }[];
    headSeq: number | null;
    headHash: string | null;
  }>(Q_LEDGER_ENTRIES);
  const entries = row?.entries ?? [];
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const fail = (reason: string): LedgerVerdict => ({ ok: false, length: entries.length, head: prev, brokenAt: e.seq, reason });
    if (e.seq !== i + 1) return fail(`sequence gap: expected ${i + 1}`);
    if (e.prev !== prev) return fail('prev does not match previous hash');
    if (sha256Hex(e.payload) !== e.payloadHash) return fail('payload does not match its hash');
    if (sha256Hex(`${prev}|${e.payloadHash}`) !== e.hash) return fail('entry hash does not recompute');
    prev = e.hash;
  }
  if ((row?.headSeq ?? 0) !== entries.length || (row?.headHash ?? GENESIS) !== prev) {
    return { ok: false, length: entries.length, head: prev, brokenAt: entries.length, reason: 'head does not match last entry' };
  }
  return { ok: true, length: entries.length, head: prev };
}
