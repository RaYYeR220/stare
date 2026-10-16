import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDesk, handle, ROSTER, routeTo, ScriptedChatModel, VeniceChatModel } from '@stare/agents';
import {
  ablate,
  adoptPolicy,
  approvalBottlenecks,
  connect,
  copyGraph,
  Db,
  decide,
  departPerson,
  draftFromCurrent,
  type EngineCtx,
  eraseSubject,
  exceptionClusters,
  graphOf,
  leadingCases,
  listRules,
  naiveControl,
  overturnDecision,
  POLICY_IDS,
  type PolicyDraft,
  type PolicyId,
  type Principal,
  policyImpact,
  probeIsolation,
  proposeRules,
  type QueryLogEntry,
  ratifyRule,
  recall,
  renderSkill,
  resolveEscalation,
  runRace,
  verifyLedger,
} from '@stare/core';
import { VeniceClient } from '@stare/llm';
import { buildNorthwind } from '@stare/seed';
import { type Context, Hono } from 'hono';
import type { Runtime } from './runtime.ts';
import { bearer, DeskFullError } from './runtime.ts';
import { decisionView, VIEW_QUERIES } from './views.ts';

const EVAL_RESULTS = fileURLToPath(new URL('../../eval/results/latest.json', import.meta.url));

/** Trace entries without embedding vectors (they are long and say nothing). */
export function cleanTrace(t: QueryLogEntry[]) {
  return t.map((e) => ({
    name: e.name,
    mode: e.mode,
    ms: Math.round(e.ms * 10) / 10,
    rows: e.rows,
    cypher: e.cypher,
    params: Object.fromEntries(
      Object.entries(e.params).map(([k, v]) => [
        k,
        Array.isArray(v) && v.length > 24 && typeof v[0] === 'number' ? `[vector × ${v.length}]` : v,
      ]),
    ),
  }));
}

class Limiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  ok(key: string): boolean {
    const now = Date.now();
    const xs = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (xs.length >= this.max) return false;
    xs.push(now);
    this.hits.set(key, xs);
    return true;
  }
}

/** Errors whose message is safe to show the caller; anything else is logged and reported generically. */
export class PublicError extends Error {}

/**
 * The client address for rate limiting. Behind our reverse proxy the last X-Forwarded-For hop is the
 * one the proxy observed; anything earlier in the header is client-supplied and ignored.
 */
function clientIp(c: Context): string {
  const sock =
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket
      ?.remoteAddress ?? 'unknown';
  const fromProxy = /^(127\.|::1|::ffff:127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(sock);
  const xff = c.req.header('x-forwarded-for');
  return fromProxy && xff ? xff.split(',').at(-1)!.trim() : sock;
}

const isPerson = (id: unknown): id is string => typeof id === 'string' && /^p-[a-z0-9-]+$/.test(id);
const isAgent = (id: unknown): id is string => typeof id === 'string' && /^a-[a-z0-9-]+$/.test(id);

export function restApi(rt: Runtime) {
  const app = new Hono<{ Variables: { sbx: string; ctx: EngineCtx } }>();
  const sessions = new Limiter(Number(process.env.STARE_SESSIONS_PER_IP ?? 6), 10 * 60_000);
  const heavy = new Limiter(240, 10 * 60_000);

  app.onError((e, c) => {
    if (e instanceof PublicError) return c.json({ error: e.message }, 400);
    if (e instanceof DeskFullError) return c.json({ error: e.message }, 503);
    console.error('[stare] request failed:', e);
    return c.json({ error: 'internal error' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true, offline: rt.models.offline, model: rt.models.llm.model }));

  /** Open the desk: a private copy of Northwind Cloud for this visitor, valid for two hours. */
  app.post('/session', async (c) => {
    const ip = clientIp(c);
    if (!sessions.ok(ip))
      return c.json({ error: 'too many desks opened from here; reuse the one you have' }, 429);
    const s = await rt.openSandbox('northwind');
    const token = rt.token(s.id, { kind: 'agent', id: 'a-support' });
    return c.json({ token, sandbox: s.id, expiresAt: s.expiresAt });
  });

  /** The pre-registered evaluation: public, so the landing page can show it. */
  app.get('/eval', (c) =>
    existsSync(EVAL_RESULTS)
      ? c.json(JSON.parse(readFileSync(EVAL_RESULTS, 'utf8')))
      : c.json({ error: 'no eval run yet' }, 404),
  );

  // everything below needs a desk token
  app.use('/*', async (c, next) => {
    const g = rt.grant(bearer(c.req.header('authorization')));
    if (!g || (g.aud ?? 'desk') !== 'desk')
      return c.json({ error: 'missing or expired desk token; open a new desk' }, 401);
    const ctx = await rt.ctx(g.sbx);
    if (!ctx) return c.json({ error: 'this desk has expired; open a new one' }, 410);
    if (c.req.method !== 'GET' && !heavy.ok(g.sbx)) return c.json({ error: 'slow down a little' }, 429);
    c.set('sbx', g.sbx);
    c.set('ctx', ctx);
    await next();
  });

  const now = () => Date.now();
  const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  app.get('/overview', async (c) => {
    const ctx = c.get('ctx');
    const [o] = await ctx.db.ro(VIEW_QUERIES.overview, { now: now() });
    const budgets = await ctx.db.ro(VIEW_QUERIES.budgets, { now: now() });
    const agents = await ctx.db.ro(VIEW_QUERIES.agents, { now: now() });
    return c.json({
      ...o,
      budgets,
      agents,
      model: rt.models.llm.model,
      offline: rt.models.offline,
      sandbox: c.get('sbx'),
    });
  });

  app.get('/cases', async (c) =>
    c.json(
      await c.get('ctx').db.ro(VIEW_QUERIES.cases, {
        limit: Math.max(
          1,
          Math.min(Number.isFinite(Number(c.req.query('limit'))) ? Number(c.req.query('limit')) : 40, 200),
        ),
      }),
    ),
  );
  app.get('/people', async (c) => c.json(await c.get('ctx').db.ro(VIEW_QUERIES.people, { now: now() })));
  app.get('/policies', async (c) => c.json(await c.get('ctx').db.ro(VIEW_QUERIES.policies, { now: now() })));
  app.get('/contacts', async (c) => c.json(await c.get('ctx').db.ro(VIEW_QUERIES.contacts, { limit: 40 })));
  app.get('/inbox', async (c) => c.json(await c.get('ctx').db.ro(VIEW_QUERIES.inbox)));

  /**
   * Decide a request as an agent (or a person); optionally show what a vector-only agent would have done.
   * The desk is a private copy per visitor, so the visitor may act as anyone in it ("actor"); every
   * authority, tenure and independence check still applies to whoever they act as. MCP tokens, by
   * contrast, are bound to one principal.
   */
  app.post('/decide', async (c) => {
    const b = await body(c);
    const text = String(b.text ?? '').slice(0, 2000);
    if (!text.trim()) return c.json({ error: 'empty request' }, 400);
    const actor = String(b.actor ?? 'a-support');
    const principal: Principal = isAgent(actor)
      ? { kind: 'agent', id: actor }
      : isPerson(actor)
        ? { kind: 'person', id: actor }
        : { kind: 'agent', id: 'a-support' };
    const ctx = c.get('ctx');
    const v = await decide(ctx, { principal, text, channel: 'desk', dryRun: !!b.dryRun });
    const a = b.ablate ? await ablate(ctx, { principal, text, intake: v.intake }) : null;
    return c.json({ verdict: { ...v, trace: cleanTrace(v.trace) }, ablation: a });
  });

  app.get('/decisions/:id', async (c) => {
    const view = await decisionView(c.get('ctx').db, c.req.param('id'), now());
    return view ? c.json(view) : c.json({ error: 'no such decision' }, 404);
  });

  app.post('/escalations/:id/resolve', async (c) => {
    const b = await body(c);
    if (!isPerson(b.personId)) return c.json({ error: 'personId required' }, 400);
    const r = await resolveEscalation(c.get('ctx'), {
      escalationId: c.req.param('id'),
      personId: b.personId,
      approve: !!b.approve,
      value: b.value === undefined || b.value === null || b.value === '' ? undefined : Number(b.value),
      note: b.note ? String(b.note).slice(0, 500) : undefined,
    });
    return c.json(r, r.ok ? 200 : 409);
  });

  app.post('/decisions/:id/overturn', async (c) => {
    const b = await body(c);
    if (!isPerson(b.personId)) return c.json({ error: 'personId required' }, 400);
    return c.json(
      await overturnDecision(
        c.get('ctx'),
        c.req.param('id'),
        b.personId,
        String(b.reason ?? 'Overturned on review.').slice(0, 300),
      ),
    );
  });

  app.get('/rules', async (c) => c.json(await listRules(c.get('ctx').db, now())));
  app.post('/rules/propose', async (c) => c.json({ created: await proposeRules(c.get('ctx')) }));
  app.post('/rules/:id/ratify', async (c) => {
    const b = await body(c);
    if (!isPerson(b.personId)) return c.json({ error: 'personId required' }, 400);
    const r = await ratifyRule(c.get('ctx'), c.req.param('id'), b.personId);
    return c.json(r, r.ok ? 200 : 409);
  });
  app.get('/rules/skill.md', async (c) =>
    c.text(renderSkill('Northwind Cloud', await listRules(c.get('ctx').db, now()), now()), 200, {
      'content-type': 'text/markdown; charset=utf-8',
    }),
  );

  const draftFrom = async (ctx: EngineCtx, b: Record<string, unknown>): Promise<PolicyDraft> => {
    const policyId = String(b.policyId) as PolicyId;
    if (!POLICY_IDS.includes(policyId)) throw new PublicError('unknown policy');
    const draft = await draftFromCurrent(ctx, policyId);
    const changes = (Array.isArray(b.changes) ? b.changes : []) as {
      key: string;
      value: unknown;
      text?: string;
    }[];
    draft.clauses = draft.clauses.map((cl) => {
      const ch = changes.find((x) => x?.key === cl.key);
      return ch ? { ...cl, text: ch.text ?? cl.text, rule: { ...cl.rule, value: ch.value } } : cl;
    });
    draft.note = b.note ? String(b.note).slice(0, 200) : undefined;
    return draft;
  };
  app.post('/policy/impact', async (c) => {
    const ctx = c.get('ctx');
    return c.json(await policyImpact(rt.admin, ctx, await draftFrom(ctx, await body(c)), { replay: 24 }));
  });
  app.post('/policy/adopt', async (c) => {
    const ctx = c.get('ctx');
    return c.json(await adoptPolicy(ctx, await draftFrom(ctx, await body(c))));
  });

  app.post('/people/:id/depart', async (c) => {
    const id = c.req.param('id');
    if (!isPerson(id)) return c.json({ error: 'bad person id' }, 400);
    return c.json(await departPerson(c.get('ctx'), id));
  });

  app.post('/erasure/:contactId', async (c) => {
    const ctx = c.get('ctx');
    const id = c.req.param('contactId');
    const control = await naiveControl(rt.admin, ctx, id).catch(() => null);
    const certificate = await eraseSubject(ctx, id);
    return certificate ? c.json({ certificate, control }) : c.json({ error: 'no such subject' }, 404);
  });
  app.get('/erasures', async (c) => c.json(await c.get('ctx').db.ro(VIEW_QUERIES.erasures)));

  /** The burst runs on a throwaway GRAPH.COPY of this desk, so it never spends the desk's own budgets. */
  app.post('/race', async (c) => {
    const ctx = c.get('ctx');
    const creds = rt.sandboxCreds(c.get('sbx'))!;
    const copy = `${creds.graph}:race:${Date.now().toString(36)}`;
    await copyGraph(rt.admin, creds.graph, copy);
    try {
      const report = await runRace(
        { ...ctx, db: new Db(ctx.db.client, copy) },
        () => connect({ url: rt.cfg.falkorUrl, username: creds.user, password: creds.password }),
        { n: 64, connections: 16 },
      );
      return c.json({ ...report, graph: copy });
    } finally {
      await rt.admin
        .selectGraph(copy)
        .delete()
        .catch(() => {});
    }
  });

  app.get('/isolation', async (c) => {
    const creds = rt.sandboxCreds(c.get('sbx'));
    if (!creds) return c.json({ error: 'desk not loaded' }, 409);
    return c.json(await probeIsolation(rt.admin, rt.cfg.falkorUrl, creds, graphOf('globex')));
  });

  app.get('/ledger', async (c) => {
    const ctx = c.get('ctx');
    return c.json({
      verify: await verifyLedger(ctx.db, { deep: true }),
      tail: await ctx.db.ro(VIEW_QUERIES.ledgerTail, { limit: 20 }),
    });
  });

  /** Requests waiting in the shared channels (the demo company's day). */
  app.get('/incoming', (c) =>
    c.json(
      buildNorthwind().inbox.map(({ expect: _e, ...i }) => ({ ...i, agent: routeTo(i.channel, i.text) })),
    ),
  );

  /** Hand one request to an agent: a model-driven tool loop over this desk's own MCP endpoint. */
  app.post('/agents/handle', async (c) => {
    const b = await body(c);
    const text = String(b.text ?? '').slice(0, 2000);
    if (!text.trim()) return c.json({ error: 'empty request' }, 400);
    const agent = (
      typeof b.agent === 'string' && Object.hasOwn(ROSTER, b.agent)
        ? b.agent
        : routeTo(String(b.channel ?? ''), text)
    ) as keyof typeof ROSTER;
    const client = await connectDesk(
      rt.selfMcpUrl,
      rt.token(c.get('sbx'), { kind: 'agent', id: agent }, 10 * 60_000, 'mcp'),
    );
    try {
      const model =
        rt.models.offline || !process.env.VENICE_API_KEY
          ? new ScriptedChatModel()
          : new VeniceChatModel(
              new VeniceClient(process.env.VENICE_API_KEY, process.env.VENICE_BASE_URL),
              process.env.STARE_AGENT_MODEL ?? rt.models.llm.model,
            );
      return c.json(await handle(ROSTER[agent], client, model, text));
    } finally {
      await client.close().catch(() => {});
    }
  });

  app.get('/algos/leading', async (c) => c.json(await leadingCases(c.get('ctx').db, now(), 10)));
  app.get('/algos/bottlenecks', async (c) => c.json(await approvalBottlenecks(c.get('ctx').db, now())));
  app.get('/algos/clusters', async (c) => c.json(await exceptionClusters(c.get('ctx').db, now())));

  app.get('/memory', async (c) => {
    const ctx = c.get('ctx');
    return c.json(
      await recall(ctx.db, ctx.embedder, {
        query: c.req.query('q') ?? 'recent requests',
        account: c.req.query('account') ?? null,
      }),
    );
  });

  /**
   * The read-only auditor: FalkorDB's own MCP server, bound to an ACL user that may only GRAPH.RO_QUERY
   * the shared Northwind graph. Handed to desk holders so they can try raw Cypher against the isolation.
   */
  app.get('/auditor', (c) =>
    process.env.STARE_AUDITOR_KEY
      ? c.json({
          url: `${rt.cfg.publicUrl}/auditor/mcp`,
          key: process.env.STARE_AUDITOR_KEY,
          graph: 'stare:northwind',
          user: 'auditor',
          allowed: ['GRAPH.RO_QUERY on stare:northwind'],
        })
      : c.json({ error: 'no auditor on this deployment' }, 404),
  );

  /** A bearer token for an MCP client, bound to this desk and one principal. */
  app.post('/mcp-token', async (c) => {
    const b = await body(c);
    const id = String(b.principal ?? 'a-support');
    const principal: Principal | null = isAgent(id)
      ? { kind: 'agent', id }
      : isPerson(id)
        ? { kind: 'person', id }
        : null;
    if (!principal) return c.json({ error: 'bad principal' }, 400);
    return c.json({
      url: `${rt.cfg.publicUrl}/mcp`,
      token: rt.token(c.get('sbx'), principal, undefined, 'mcp'),
      principal,
    });
  });

  return app;
}
