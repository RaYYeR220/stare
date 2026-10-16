import { randomBytes } from 'node:crypto';
import type { Db, NamedQuery } from './db.ts';
import type { Embedder } from './embed.ts';

const q = (name: string, mode: 'ro' | 'rw', doc: string, cypher: string): NamedQuery => ({
  name,
  mode,
  doc,
  cypher: cypher.trim(),
});

export const MEMORY_QUERIES = {
  episodesByVector: q(
    'memory.episodes',
    'ro',
    'Episodic memory: past sessions of any agent, nearest to the question (shared across agents, private to the tenant).',
    `
CALL db.idx.vector.queryNodes('Episode', 'embedding', $k, vecf32($vec)) YIELD node, score
MATCH (a:Agent)-[:HAD]->(node)
RETURN 'episode' AS kind, node.id AS id, node.summary AS text, node.at AS at, a.id AS agent, 1 - score AS similarity`,
  ),
  factsByVector: q(
    'memory.facts',
    'ro',
    'Semantic memory: facts nearest to the question, each with the messages it was derived from.',
    `
CALL db.idx.vector.queryNodes('Fact', 'embedding', $k, vecf32($vec)) YIELD node, score
OPTIONAL MATCH (node)-[:DERIVED_FROM]->(s:Span)-[:IN]->(src:Source)
RETURN 'fact' AS kind, node.id AS id, node.text AS text, node.at AS at, 1 - score AS similarity,
       collect(DISTINCT src.channel + ' · ' + src.title) AS sources`,
  ),
  aboutAccount: q(
    'memory.aboutAccount',
    'ro',
    'Graph expansion: everything remembered about one account (facts, episodes, open handoffs), regardless of wording.',
    `
MATCH (a:Account) WHERE toLower(a.name) = toLower($account)
OPTIONAL MATCH (f:Fact)-[:ABOUT]->(a)
OPTIONAL MATCH (e:Episode)-[:ABOUT]->(a)
OPTIONAL MATCH (ag:Agent)-[:HAD]->(e)
WITH a, collect(DISTINCT {kind:'fact', id:f.id, text:f.text, at:f.at}) AS facts,
        collect(DISTINCT {kind:'episode', id:e.id, text:e.summary, at:e.at, agent:ag.id}) AS episodes
RETURN a.id AS accountId, facts, episodes`,
  ),
  lastEpisode: q(
    'memory.lastEpisode',
    'ro',
    "An agent's most recent episode (where its next session picks up).",
    `MATCH (:Agent {id:$agentId})-[:HAD]->(e:Episode) RETURN e.id AS id, e.summary AS summary, e.at AS at, e.sessionId AS sessionId ORDER BY e.at DESC LIMIT 1`,
  ),
  remember: q(
    'memory.remember',
    'rw',
    'Write an episode: link it to the agent, to the previous episode, and to what it was about.',
    `
MATCH (a:Agent {id:$agentId})
OPTIONAL MATCH (a)-[:HAD]->(prev:Episode) WHERE NOT (prev)-[:NEXT]->(:Episode)
CREATE (a)-[:HAD]->(e:Episode {id:$id, agentId:$agentId, sessionId:$sessionId, at:$now, summary:$summary, embedding:vecf32($vec)})
FOREACH (p IN CASE WHEN prev IS NULL THEN [] ELSE [prev] END | CREATE (p)-[:NEXT]->(e))
WITH e
UNWIND (CASE WHEN size($about) = 0 THEN [null] ELSE $about END) AS x
OPTIONAL MATCH (n {id:x}) WHERE n:Account OR n:Case OR n:Decision
FOREACH (m IN CASE WHEN n IS NULL THEN [] ELSE [n] END | CREATE (e)-[:ABOUT]->(m))
RETURN DISTINCT e.id AS id`,
  ),
  handoff: q(
    'memory.handoff',
    'rw',
    'Hand a case to another agent, with a note that travels with it.',
    `
MATCH (f:Agent {id:$from}), (t:Agent {id:$to})
CREATE (f)-[:HANDED_OFF]->(h:Handoff {id:$id, caseId:$caseId, note:$note, at:$now, status:'open'})-[:TO]->(t)
WITH h
OPTIONAL MATCH (c:Case {id:$caseId})
FOREACH (x IN CASE WHEN c IS NULL THEN [] ELSE [c] END | CREATE (h)-[:FOR]->(x))
RETURN h.id AS id`,
  ),
  inbox: q(
    'memory.handoffInbox',
    'ro',
    'Open handoffs waiting for an agent.',
    `
MATCH (f:Agent)-[:HANDED_OFF]->(h:Handoff {status:'open'})-[:TO]->(:Agent {id:$agentId})
RETURN h.id AS id, f.id AS from, h.caseId AS caseId, h.note AS note, h.at AS at ORDER BY h.at`,
  ),
  accept: q(
    'memory.acceptHandoff',
    'rw',
    'Accept a handoff.',
    `MATCH (h:Handoff {id:$id})-[:TO]->(:Agent {id:$agentId}) WHERE h.status = 'open' SET h.status = 'accepted', h.acceptedAt = $now RETURN h.id AS id`,
  ),
} as const;

export interface MemoryItem {
  kind: 'fact' | 'episode';
  id: string;
  text: string;
  at: number;
  agent?: string;
  similarity?: number;
  sources?: string[];
  via: 'vector' | 'graph' | 'both';
}

/** Recall for an agent: vector search over episodes and facts, expanded through the account in the graph. */
export async function recall(
  db: Db,
  embedder: Embedder,
  input: { query: string; account?: string | null; k?: number },
): Promise<MemoryItem[]> {
  const [vec] = await embedder.embed([input.query]);
  const k = input.k ?? 6;
  const eps = await db.ro<MemoryItem>(MEMORY_QUERIES.episodesByVector, { k, vec });
  const facts = await db.ro<MemoryItem>(MEMORY_QUERIES.factsByVector, { k, vec });
  const out = new Map<string, MemoryItem>();
  for (const x of [...facts, ...eps]) out.set(x.id, { ...x, via: 'vector' });
  if (input.account) {
    const [row] = await db.ro<{ facts: MemoryItem[]; episodes: MemoryItem[] }>(MEMORY_QUERIES.aboutAccount, {
      account: input.account,
    });
    for (const x of [...(row?.facts ?? []), ...(row?.episodes ?? [])]) {
      if (!x.id) continue;
      const prev = out.get(x.id);
      out.set(x.id, prev ? { ...prev, via: 'both' } : { ...x, via: 'graph' });
    }
  }
  return [...out.values()].sort(
    (a, b) =>
      (b.via === 'both' ? 1 : 0) - (a.via === 'both' ? 1 : 0) ||
      (b.similarity ?? 0) - (a.similarity ?? 0) ||
      b.at - a.at,
  );
}

export async function remember(
  db: Db,
  embedder: Embedder,
  input: { agentId: string; sessionId: string; summary: string; about?: string[]; now: number },
) {
  const [vec] = await embedder.embed([input.summary]);
  const id = `ep-${randomBytes(5).toString('hex')}`;
  await db.rw(MEMORY_QUERIES.remember, {
    id,
    agentId: input.agentId,
    sessionId: input.sessionId,
    summary: input.summary,
    vec,
    about: input.about ?? [],
    now: input.now,
  });
  return id;
}

export async function lastEpisode(db: Db, agentId: string) {
  const [row] = await db.ro<{ id: string; summary: string; at: number; sessionId: string }>(
    MEMORY_QUERIES.lastEpisode,
    { agentId },
  );
  return row ?? null;
}

export async function handoff(
  db: Db,
  input: { from: string; to: string; caseId?: string | null; note: string; now: number },
) {
  const id = `ho-${randomBytes(5).toString('hex')}`;
  await db.rw(MEMORY_QUERIES.handoff, {
    id,
    from: input.from,
    to: input.to,
    caseId: input.caseId ?? '',
    note: input.note,
    now: input.now,
  });
  return id;
}

export async function handoffInbox(db: Db, agentId: string) {
  return db.ro<{ id: string; from: string; caseId: string; note: string; at: number }>(MEMORY_QUERIES.inbox, {
    agentId,
  });
}

export async function acceptHandoff(db: Db, id: string, agentId: string, now: number) {
  const { rows } = await db.rw<{ id: string }>(MEMORY_QUERIES.accept, { id, agentId, now });
  return rows.length > 0;
}
