import { randomBytes } from 'node:crypto';
import type { FalkorDB } from 'falkordb';
import { copyGraph } from './copy.ts';
import { Db, type NamedQuery } from './db.ts';
import type { EngineCtx } from './engine/decide.ts';
import { canonicalJson, LEDGER_HEAD, ledgerParams, ledgerWrite, sha256Hex, verifyLedger } from './ledger.ts';

const q = (name: string, mode: 'ro' | 'rw', doc: string, cypher: string): NamedQuery => ({
  name,
  mode,
  doc,
  cypher: cypher.trim(),
});

export const ERASURE_QUERIES = {
  subject: q(
    'erasure.subject',
    'ro',
    'The data subject, their salt and their account.',
    `
MATCH (k:Contact {id:$contactId})
OPTIONAL MATCH (k)-[:SALTED_BY]->(s:Salt)
OPTIONAL MATCH (k)-[:CONTACT_OF]->(a:Account)
RETURN k.name AS name, k.email AS email, k.phone AS phone, s.value AS salt, a.name AS account`,
  ),
  scan: q(
    'erasure.scanTerms',
    'ro',
    'Every node and edge property, across every label and relationship type, that still contains an identifier (stare.scanTerms).',
    `
CALL db.labels() YIELD label
WITH collect(label) AS ls
CALL db.relationshipTypes() YIELD relationshipType
WITH ls, collect(relationshipType) AS rs
RETURN stare.scanTerms($terms, ls, rs) AS hits`,
  ),
  affectedSpans: q(
    'erasure.affectedSpans',
    'ro',
    'Messages that mention the subject, by edge or by text.',
    `
MATCH (s:Span)
OPTIONAL MATCH (s)-[m:MENTIONS]->(:Contact {id:$contactId})
WITH s, count(m) AS mentions
WHERE mentions > 0 OR any(t IN $terms WHERE toLower(s.text) CONTAINS toLower(t))
RETURN s.id AS id, s.embedding AS embedding`,
  ),
  facts: q(
    'erasure.factSupport',
    'ro',
    'Facts derived from the affected messages, and how much independent support each has left.',
    `
MATCH (f:Fact)-[:DERIVED_FROM]->(s:Span) WHERE s.id IN $spanIds
WITH DISTINCT f
OPTIONAL MATCH (f)-[:DERIVED_FROM]->(o:Span) WHERE NOT o.id IN $spanIds
WITH f, collect(o.id) AS support
RETURN f.id AS id, f.text AS text, f.embedding AS embedding, support`,
  ),
  touched: q(
    'erasure.touched',
    'ro',
    'Decisions, cases, episodes, facts and handoff notes grounded in the affected messages or naming the subject.',
    `
MATCH (n) WHERE (n:Decision OR n:Case OR n:Episode OR n:Fact OR n:Handoff)
OPTIONAL MATCH (n)-[g:GROUNDED_IN|FROM]->(s:Span) WHERE s.id IN $spanIds
WITH n, count(g) AS grounded,
     CASE WHEN n:Decision THEN n.narrative WHEN n:Case THEN n.text WHEN n:Episode THEN n.summary WHEN n:Handoff THEN n.note ELSE n.text END AS txt
WHERE grounded > 0 OR any(t IN $terms WHERE toLower(coalesce(txt, '')) CONTAINS toLower(t))
RETURN n.id AS id, labels(n)[0] AS label, txt AS text, n.embedding AS embedding`,
  ),
  open: q(
    'erasure.open',
    'rw',
    'Open the erasure record (the tombstone that decisions stay grounded in).',
    `CREATE (e:Erasure {id:$id, at:$now, status:'running', subjectCommitment:$commitment}) RETURN e.id AS id`,
  ),
  deleteFacts: q(
    'erasure.deleteFacts',
    'rw',
    'Delete facts left with no independent support.',
    `MATCH (f:Fact) WHERE f.id IN $ids DETACH DELETE f`,
  ),
  rewrite: q(
    'erasure.rewrite',
    'rw',
    'Rewrite redacted text and its embedding in place (structure, authority and citations are kept).',
    `
UNWIND $rows AS r
MATCH (n {id:r.id}) WHERE n:Decision OR n:Case OR n:Episode OR n:Fact OR n:Handoff
FOREACH (x IN CASE WHEN n:Decision THEN [n] ELSE [] END | SET x.narrative = r.text)
FOREACH (x IN CASE WHEN n:Handoff THEN [n] ELSE [] END | SET x.note = r.text)
FOREACH (x IN CASE WHEN n:Case OR n:Fact THEN [n] ELSE [] END | SET x.text = r.text)
FOREACH (x IN CASE WHEN n:Episode THEN [n] ELSE [] END | SET x.summary = r.text)
FOREACH (x IN CASE WHEN r.vec IS NULL THEN [] ELSE [n] END | SET x.embedding = vecf32(r.vec))
RETURN count(n) AS n`,
  ),
  regroundDecisions: q(
    'erasure.reground',
    'rw',
    'Decisions grounded in erased messages are re-grounded in the erasure record.',
    `
MATCH (e:Erasure {id:$erasureId})
MATCH (d:Decision)-[g:GROUNDED_IN]->(s:Span) WHERE s.id IN $spanIds
DELETE g
MERGE (d)-[:GROUNDED_IN]->(e)
RETURN count(DISTINCT d) AS n`,
  ),
  deleteSpans: q(
    'erasure.deleteSpans',
    'rw',
    'Delete the affected messages, then any source left empty.',
    `
MATCH (s:Span) WHERE s.id IN $spanIds
OPTIONAL MATCH (s)-[:IN]->(src:Source)
DETACH DELETE s
WITH DISTINCT src WHERE src IS NOT NULL
OPTIONAL MATCH (rest:Span)-[:IN]->(src)
WITH src, count(rest) AS left WHERE left = 0
DETACH DELETE src
RETURN count(src) AS sources`,
  ),
  shred: q(
    'erasure.shred',
    'rw',
    'Delete the subject and their salt. Ledger entries keep their commitments, which can no longer be linked to anyone.',
    `
MATCH (k:Contact {id:$contactId})
OPTIONAL MATCH (k)-[:SALTED_BY]->(s:Salt)
DETACH DELETE k, s
RETURN 1 AS ok`,
  ),
  leftovers: q(
    'erasure.leftovers',
    'ro',
    'Anything still keyed by the subject id.',
    `MATCH (n) WHERE n.id IN [$contactId, 'salt-' + $contactId] RETURN count(n) AS n`,
  ),
  knn: q(
    'erasure.vectorProbe',
    'ro',
    'Nearest stored vector to a vector that existed before erasure (cosine distance; 0 means it is still there).',
    `CALL db.idx.vector.queryNodes($label, 'embedding', 1, vecf32($vec)) YIELD node, score RETURN node.id AS id, score`,
  ),
  close: q(
    'erasure.close',
    'rw',
    'Store the certificate and record it in the ledger.',
    `
${LEDGER_HEAD}
MATCH (e:Erasure {id:$erasureId})
SET e.status = 'complete', e.certificate = $certificate, e.certificateHash = $certificateHash
${ledgerWrite(['e'])}
SET e.ledgerSeq = le.seq
CREATE (le)-[:RECORDS]->(e)
RETURN le.seq AS seq`,
  ),
} as const;

export interface Check {
  id: 'C1' | 'C2' | 'C3' | 'C4';
  name: string;
  pass: boolean;
  detail: string;
}

export interface Certificate {
  erasureId: string;
  subjectCommitment: string;
  at: number;
  counts: {
    messagesErased: number;
    sourcesErased: number;
    factsDeleted: string[];
    factsRetained: { id: string; support: string[] }[];
    recordsRedacted: number;
    vectorsRewritten: number;
    decisionsRegrounded: number;
  };
  checks: Check[];
  ledger: { ok: boolean; length: number; head: string };
  verdict: 'ERASED' | 'REFUSED';
  certificateHash: string;
}

interface Snapshot {
  contactId: string;
  terms: string[];
  vectors: { label: string; vec: number[] }[];
}

export function redact(text: string, terms: string[]): string {
  let out = text;
  for (const t of [...terms].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[erased]');
  }
  return out;
}

function termsOf(s: { name: string; email: string; phone: string }): string[] {
  const parts = s.name.split(/\s+/).filter((p) => p.length >= 4);
  return [...new Set([s.name, s.email, s.phone, s.email.split('@')[0]!, ...parts])].filter(
    (t) => t && t.length >= 3,
  );
}

/** The four checks of the certificate. The same function judges the real erasure and the naive control. */
export async function audit(
  db: Db,
  snap: Snapshot,
): Promise<{ checks: Check[]; ledger: { ok: boolean; length: number; head: string } }> {
  const [scan] = await db.ro<{ hits: { label: string; id: string; key: string; term: string }[] }>(
    ERASURE_QUERIES.scan,
    { terms: snap.terms },
  );
  const hits = scan?.hits ?? [];
  const [idScan] = await db.ro<{ hits: unknown[] }>(ERASURE_QUERIES.scan, { terms: [snap.contactId] });
  const [left] = await db.ro<{ n: number }>(ERASURE_QUERIES.leftovers, { contactId: snap.contactId });
  let closest = Number.POSITIVE_INFINITY;
  let survivors = 0;
  for (const v of snap.vectors) {
    const [hit] = await db.ro<{ id: string; score: number }>(ERASURE_QUERIES.knn, {
      label: v.label,
      vec: v.vec,
    });
    if (!hit) continue;
    closest = Math.min(closest, hit.score);
    if (hit.score <= 0.02) survivors++;
  }
  const ledger = await verifyLedger(db, { deep: true });
  const checks: Check[] = [
    {
      id: 'C1',
      name: 'No property anywhere contains an identifier of the subject',
      pass: hits.length === 0,
      detail: hits.length
        ? `${hits.length} hit(s), e.g. ${hits
            .slice(0, 3)
            .map((h) => `${h.label}.${h.key}`)
            .join(', ')}`
        : `scanned every label and relationship type for ${snap.terms.length} identifiers`,
    },
    {
      id: 'C2',
      name: 'The subject and their salt are gone; nothing references their id',
      pass: (left?.n ?? 0) === 0 && (idScan?.hits.length ?? 0) === 0,
      detail: `${left?.n ?? 0} node(s) keyed by the subject, ${idScan?.hits.length ?? 0} reference(s) to the id`,
    },
    {
      id: 'C3',
      name: 'No stored vector equals a vector that encoded the subject',
      pass: survivors === 0,
      detail: `${snap.vectors.length} pre-erasure vectors probed; ${survivors} still present${Number.isFinite(closest) ? `; closest distance ${closest.toFixed(3)}` : ''}`,
    },
    {
      id: 'C4',
      name: 'The hash-chained ledger still verifies end to end (crypto-shredding, no rewrite)',
      pass: ledger.ok,
      detail: ledger.ok ? `${ledger.length} entries recomputed` : `${ledger.reason}`,
    },
  ];
  return { checks, ledger: { ok: ledger.ok, length: ledger.length, head: ledger.head } };
}

async function snapshot(ctx: EngineCtx, contactId: string) {
  const [s] = await ctx.db.ro<{
    name: string;
    email: string;
    phone: string;
    salt: string | null;
    account: string;
  }>(ERASURE_QUERIES.subject, { contactId });
  if (!s) return null;
  const terms = termsOf(s);
  const spans = await ctx.db.ro<{ id: string; embedding: number[] }>(ERASURE_QUERIES.affectedSpans, {
    contactId,
    terms,
  });
  const spanIds = spans.map((x) => x.id);
  const facts = await ctx.db.ro<{ id: string; text: string; embedding: number[]; support: string[] }>(
    ERASURE_QUERIES.facts,
    { spanIds },
  );
  const touched = await ctx.db.ro<{
    id: string;
    label: string;
    text: string | null;
    embedding: number[] | null;
  }>(ERASURE_QUERIES.touched, { spanIds, terms });
  const vectors = [
    ...spans.filter((x) => x.embedding).map((x) => ({ label: 'Span', vec: x.embedding })),
    ...touched
      .filter((x) => x.embedding && x.text && redact(x.text, terms) !== x.text)
      .map((x) => ({ label: x.label, vec: x.embedding! })),
  ];
  const commitment = s.salt ? sha256Hex(`${s.salt}|${contactId}`) : sha256Hex(`unsalted|${contactId}`);
  return {
    subject: s,
    terms,
    spanIds,
    facts,
    touched,
    snap: { contactId, terms, vectors } as Snapshot,
    commitment,
  };
}

export function certificateHash(c: Omit<Certificate, 'certificateHash'>): string {
  return sha256Hex(canonicalJson(c));
}

/** Recompute a certificate's hash and confirm every check passed. */
export function verifyCertificate(c: Certificate): boolean {
  const { certificateHash: h, ...rest } = c;
  return certificateHash(rest) === h && c.checks.every((x) => x.pass) && c.verdict === 'ERASED';
}

/**
 * Forget with proof. Erase a data subject across messages, facts, decisions, cases, episodes and
 * vectors; keep the business record (who decided what, under which authority, citing what); shred
 * the salt so the ledger keeps verifying; then prove it with four checks and record the certificate.
 */
export async function eraseSubject(ctx: EngineCtx, contactId: string): Promise<Certificate | null> {
  const now = ctx.clock.now();
  const pre = await snapshot(ctx, contactId);
  if (!pre) return null;
  const erasureId = `erasure-${randomBytes(5).toString('hex')}`;
  await ctx.db.rw(ERASURE_QUERIES.open, { id: erasureId, now, commitment: pre.commitment });

  const orphans = pre.facts.filter((f) => f.support.length === 0).map((f) => f.id);
  const retained = pre.facts.filter((f) => f.support.length > 0);
  await ctx.db.rw(ERASURE_QUERIES.deleteFacts, { ids: orphans });

  const rewrites = pre.touched.filter(
    (t) => !orphans.includes(t.id) && t.text && redact(t.text, pre.terms) !== t.text,
  );
  const texts = rewrites.map((t) => redact(t.text!, pre.terms));
  const vecs = texts.length ? await ctx.embedder.embed(texts) : [];
  await ctx.db.rw(ERASURE_QUERIES.rewrite, {
    rows: rewrites.map((t, i) => ({ id: t.id, text: texts[i], vec: t.embedding ? vecs[i] : null })),
  });
  const [reg] = (
    await ctx.db.rw<{ n: number }>(ERASURE_QUERIES.regroundDecisions, { erasureId, spanIds: pre.spanIds })
  ).rows;
  const [del] = (await ctx.db.rw<{ sources: number }>(ERASURE_QUERIES.deleteSpans, { spanIds: pre.spanIds }))
    .rows;
  await ctx.db.rw(ERASURE_QUERIES.shred, { contactId });

  const { checks, ledger } = await audit(ctx.db, pre.snap);
  const body: Omit<Certificate, 'certificateHash'> = {
    erasureId,
    subjectCommitment: pre.commitment,
    at: now,
    counts: {
      messagesErased: pre.spanIds.length,
      sourcesErased: del?.sources ?? 0,
      factsDeleted: orphans,
      factsRetained: retained.map((f) => ({ id: f.id, support: f.support })),
      recordsRedacted: rewrites.length,
      vectorsRewritten: rewrites.filter((t) => t.embedding).length,
      decisionsRegrounded: reg?.n ?? 0,
    },
    checks,
    ledger,
    verdict: checks.every((c) => c.pass) ? 'ERASED' : 'REFUSED',
  };
  const cert: Certificate = { ...body, certificateHash: certificateHash(body) };
  if (cert.verdict === 'ERASED') {
    // The certificate is final once hashed; the ledger entry that records it comes next in the chain.
    await ctx.db.rw(ERASURE_QUERIES.close, {
      erasureId,
      certificate: JSON.stringify(cert),
      certificateHash: cert.certificateHash,
      ...ledgerParams('erasure', erasureId, now, {
        subjectCommitment: pre.commitment,
        certificateHash: cert.certificateHash,
      }),
    });
  }
  return cert;
}

/**
 * Negative control: what most systems call "deleting a user" — remove the contact node and nothing else —
 * run on a GRAPH.COPY and judged by the same four checks. It must fail; otherwise the checks prove nothing.
 */
export async function naiveControl(
  admin: FalkorDB,
  ctx: EngineCtx,
  contactId: string,
): Promise<{ checks: Check[]; verdict: 'ERASED' | 'REFUSED' }> {
  const pre = await snapshot(ctx, contactId);
  if (!pre) throw new Error('no such subject');
  const copy = `${ctx.db.graphName}:control:${randomBytes(4).toString('hex')}`;
  await copyGraph(admin, ctx.db.graphName, copy);
  try {
    const db = new Db(ctx.db.client, copy);
    await db.rw('MATCH (k:Contact {id:$id}) DETACH DELETE k', { id: contactId });
    const { checks } = await audit(db, pre.snap);
    return { checks, verdict: checks.every((c) => c.pass) ? 'ERASED' : 'REFUSED' };
  } finally {
    await admin
      .selectGraph(copy)
      .delete()
      .catch(() => {});
  }
}
