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
 * Cypher head for any query that writes something the ledger must record. Put it FIRST, before any
 * CREATE: if the ledger head is missing the query matches nothing and writes nothing (fail closed),
 * instead of committing a decision with no ledger entry.
 */
export const LEDGER_HEAD = "MATCH (lh:LedgerHead {id:'head'})";

/**
 * Cypher tail that appends one entry to the hash chain inside the caller's write query. `lh` must be
 * bound by LEDGER_HEAD. The new hash is computed in the database (stare.sha256), so concurrent
 * writers serialize on the graph's single writer and the chain can never fork.
 */
export function ledgerWrite(carry: string[] = []): string {
  const keep = carry.length ? `${carry.join(', ')}, ` : '';
  return `
WITH ${keep}lh, stare.sha256(lh.hash + '|' + $ledgerPayloadHash) AS __nh
CREATE (le:LedgerEntry {seq: lh.seq + 1, kind: $ledgerKind, refId: $ledgerRefId, payload: $ledgerPayload,
                        payloadHash: $ledgerPayloadHash, prev: lh.hash, hash: __nh, at: $ledgerAt})
SET lh.seq = lh.seq + 1, lh.hash = __nh`;
}

/** Fields of a decision the ledger commits to. Verification compares them with the live node. */
export const DECISION_LEDGER_FIELDS = ['caseId', 'outcome', 'value', 'basis', 'policyVersionId', 'madeBy', 'at'] as const;

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
  cypher: `${LEDGER_HEAD}${ledgerWrite()}\nRETURN le.seq AS seq, le.hash AS hash`,
};

export const Q_LEDGER_DECISIONS: NamedQuery = {
  name: 'ledger.decisions',
  mode: 'ro',
  doc: 'Every decision with the fields the ledger committed to (for the deep check).',
  cypher: `MATCH (d:Decision)
OPTIONAL MATCH (d)-[:MADE_BY]->(m)
RETURN d.id AS id, d.caseId AS caseId, d.outcome AS outcome, d.value AS value, d.basis AS basis,
       d.policyVersionId AS policyVersionId, m.id AS madeBy, d.at AS at`,
};

export interface LedgerVerdict {
  ok: boolean;
  length: number;
  head: string;
  brokenAt?: number;
  reason?: string;
  /** Deep check: decisions whose live fields differ from what the ledger committed, or that it never recorded. */
  decisionsChecked?: number;
  mismatched?: { id: string; field: string; ledger: unknown; live: unknown }[];
  unrecorded?: string[];
  vanished?: string[];
}

/**
 * Recomputes every link client-side (Node crypto), independent of the in-database hashing.
 * With `deep`, also proves the live Decision nodes still say what the ledger committed to,
 * and that no decision exists outside the ledger.
 */
export async function verifyLedger(db: Db, opts: { deep?: boolean } = {}): Promise<LedgerVerdict> {
  const [row] = await db.ro<{
    entries: { seq: number; kind: string; refId: string; payload: string; payloadHash: string; prev: string; hash: string }[];
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
    // kind/refId are stored beside the payload for indexing; only the hashed payload is authoritative.
    let body: { kind?: unknown; refId?: unknown };
    try {
      body = JSON.parse(e.payload);
    } catch {
      return fail('payload is not JSON');
    }
    if (body.kind !== e.kind || body.refId !== e.refId) return fail('entry kind/refId differ from the hashed payload');
    prev = e.hash;
  }
  if (row?.headSeq == null || row.headHash == null) {
    return { ok: false, length: entries.length, head: prev, brokenAt: 0, reason: 'ledger head missing' };
  }
  if (row.headSeq !== entries.length || row.headHash !== prev) {
    return { ok: false, length: entries.length, head: prev, brokenAt: entries.length, reason: 'head does not match last entry' };
  }
  if (!opts.deep) return { ok: true, length: entries.length, head: prev };

  const committed = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    const body = JSON.parse(e.payload) as Record<string, unknown>;
    if (body.kind === 'decision') committed.set(String(body.refId), body);
  }
  const live = await db.ro<Record<string, unknown> & { id: string }>(Q_LEDGER_DECISIONS);
  const mismatched: NonNullable<LedgerVerdict['mismatched']> = [];
  const unrecorded: string[] = [];
  for (const d of live) {
    const c = committed.get(d.id);
    if (!c) {
      unrecorded.push(d.id);
      continue;
    }
    for (const f of DECISION_LEDGER_FIELDS) {
      if (canonicalJson(c[f] ?? null) !== canonicalJson(d[f] ?? null)) mismatched.push({ id: d.id, field: f, ledger: c[f], live: d[f] });
    }
  }
  const liveIds = new Set(live.map((d) => d.id));
  const vanished = [...committed.keys()].filter((id) => !liveIds.has(id));
  const ok = mismatched.length === 0 && unrecorded.length === 0 && vanished.length === 0;
  const reason = unrecorded.length
    ? 'decisions missing from the ledger'
    : vanished.length
      ? 'recorded decisions no longer exist'
      : 'decision differs from what the ledger recorded';
  return {
    ok,
    length: entries.length,
    head: prev,
    decisionsChecked: live.length,
    mismatched,
    unrecorded,
    vanished,
    ...(ok ? {} : { reason }),
  };
}
