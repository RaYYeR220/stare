import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { copyGraph, Db, HashEmbedder, HeuristicLlm, templateOf } from '@stare/core';
import { ANCHOR, buildGlobex, buildNorthwind, seedGraph } from '@stare/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, freshDb, TEST_URL } from '../../core/test/helpers.ts';
import { buildApp } from '../src/app.ts';
import { Runtime } from '../src/runtime.ts';

let rt: Runtime;
let base: string;
let server: ReturnType<typeof serve>;
let url: string;

beforeAll(async () => {
  process.env.STARE_SESSIONS_PER_IP = '100';
  const admin = await adminClient();
  // seed pristine templates under test names, then point the runtime's template names at them
  for (const [tenant, build] of [
    ['northwind', buildNorthwind],
    ['globex', buildGlobex],
  ] as const) {
    const db = await freshDb(`srv-${tenant}`, 32);
    await seedGraph(db, build(), { embedder: new HashEmbedder(32), now: ANCHOR, skipSchema: true });
    for (const g of [templateOf(tenant), `stare:${tenant}`]) {
      if ((await admin.list()).includes(g)) await admin.selectGraph(g).delete();
      await copyGraph(admin, db.graphName, g);
    }
    if (tenant === 'northwind') base = db.graphName;
  }
  rt = new Runtime({
    falkorUrl: TEST_URL,
    tokenSecret: 'test-secret',
    publicUrl: 'http://127.0.0.1:0',
    sandboxTtlMs: 600_000,
    maxSandboxes: 50,
    port: 0,
    embedCache: '/nonexistent',
  });
  await rt.start();
  // offline, deterministic models for the test
  (rt as unknown as { models: unknown }).models = {
    llm: new HeuristicLlm(buildNorthwind().accounts.map((a) => a.name)),
    embedder: new HashEmbedder(32),
    offline: true,
  };
  (rt as unknown as { embedder: unknown }).embedder = new HashEmbedder(32);
  const app = buildApp(rt);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      url = `http://127.0.0.1:${info.port}`;
      rt.selfMcpUrl = `${url}/mcp`;
      resolve();
    });
  });
}, 180_000);

afterAll(async () => {
  server?.close();
  await rt?.stop();
});

async function desk() {
  const r = await fetch(`${url}/api/session`, { method: 'POST' });
  expect(r.status).toBe(200);
  return (await r.json()) as { token: string; sandbox: string };
}

const api =
  (token: string) =>
  async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${url}/api${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

async function mcpToken(deskToken: string, principal = 'a-support'): Promise<string> {
  const r = await api(deskToken)('/mcp-token', { method: 'POST', body: JSON.stringify({ principal }) });
  expect(r.status).toBe(200);
  return r.body.token as string;
}

async function mcpClient(
  token: string,
  onElicit?: (msg: string) => Record<string, string | number | boolean> | null,
) {
  const client = new Client(
    { name: 'test', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' } },
  );
  if (onElicit) {
    client.setRequestHandler('elicitation/create', async (req: { params: { message: string } }) => {
      const content = onElicit(req.params.message);
      return content
        ? { action: 'accept' as const, content: content as Record<string, string | number | boolean> }
        : { action: 'decline' as const };
    });
  }
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe('REST desk', () => {
  it('opens a private desk and decides the hero request with a structure-off comparison', async () => {
    const { token } = await desk();
    const call = api(token);
    const r = await call('/decide', {
      method: 'POST',
      body: JSON.stringify({ text: buildNorthwind().inbox[0]!.text, ablate: true }),
    });
    expect(r.status).toBe(200);
    expect(r.body.verdict.outcome).toBe('counter');
    expect(
      r.body.verdict.trace.find((t: { name: string }) => t.name === 'engine.vectorSeeds').params.vec,
    ).toMatch(/vector/);
    expect(r.body.ablation.precedent).toBeTruthy();
    const view = await call(`/decisions/${r.body.verdict.decisionId}`);
    expect(view.body.decision.standing.flag).toBe('green');
  });

  it('answers a repeated request with the recorded decision and its full analysis', async () => {
    const { token } = await desk();
    const call = api(token);
    const body = JSON.stringify({ text: buildNorthwind().inbox[0]!.text });
    const first = (await call('/decide', { method: 'POST', body })).body.verdict;
    const again = (await call('/decide', { method: 'POST', body })).body.verdict;
    expect(again.refusal.code).toBe('REPLAY');
    expect(again.decisionId).toBe(first.decisionId);
    expect(again.outcome).toBe(first.outcome);
    const ids = (v: { citations: { id: string }[] }) => v.citations.map((c) => c.id).sort();
    expect(ids(again)).toEqual(ids(first));
    expect(again.candidates.length).toBe(first.candidates.length);
  });

  it('runs the race on a copy, leaving the desk budgets untouched', async () => {
    const { token } = await desk();
    const call = api(token);
    const before = (await call('/overview')).body.budgets;
    const race = await call('/race', { method: 'POST' });
    expect(race.status).toBe(200);
    expect((await call('/overview')).body.budgets).toEqual(before);
    const hero = await call('/decide', {
      method: 'POST',
      body: JSON.stringify({ text: buildNorthwind().inbox[0]!.text }),
    });
    expect(hero.body.verdict.outcome).toBe('counter');
  });

  it('rejects requests without a desk token, and probes isolation from the database side', async () => {
    expect((await fetch(`${url}/api/overview`)).status).toBe(401);
    const { token } = await desk();
    const probe = await api(token)('/isolation');
    expect(probe.body.ownGraph.ok).toBe(true);
    expect(probe.body.attempts.every((a: { error: string }) => /NOPERM/.test(a.error))).toBe(true);
  });

  it('runs the race and an erasure with its control', async () => {
    const { token } = await desk();
    const call = api(token);
    const race = await call('/race', { method: 'POST' });
    expect(race.body.invariants.every((i: { pass: boolean }) => i.pass)).toBe(true);
    const er = await call('/erasure/c-acmelogistics-1', { method: 'POST' });
    expect(er.body.certificate.verdict).toBe('ERASED');
    expect(er.body.control.verdict).toBe('REFUSED');
  }, 120_000);
});

describe('agents over MCP', () => {
  it('an agent handles a request through the desk tools and remembers it', async () => {
    const { token } = await desk();
    const call = api(token);
    const t = await call('/agents/handle', {
      method: 'POST',
      body: JSON.stringify({ text: buildNorthwind().inbox[1]!.text, channel: '#support-escalations' }),
    });
    expect(t.status).toBe(200);
    expect(
      t.body.steps.filter((s: { kind: string }) => s.kind === 'tool').map((s: { tool: string }) => s.tool),
    ).toEqual(['recall', 'file_exception', 'remember']);
    expect(t.body.reply).toMatch(/APPROVED/);
    const mem = await call('/memory?q=Harbor%20City%20Transit%20refund');
    expect(mem.body.some((i: { text: string }) => /Harbor City Transit/.test(i.text))).toBe(true);
  });
});

describe('MCP endpoint', () => {
  it('lists tools, files an exception, and binds the tenant to the token', async () => {
    const { token } = await desk();
    const client = await mcpClient(await mcpToken(token));
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const n of [
      'file_exception',
      'check_standing',
      'approve_escalation',
      'erase_subject',
      'leading_cases',
      'policy_impact',
      'recall',
      'handoff',
    ])
      expect(names).toContain(n);
    const res = (await client.callTool({
      name: 'file_exception',
      arguments: { request: buildNorthwind().inbox[6]!.text },
    })) as any;
    expect(res.structuredContent.outcome).toBe('escalated');
    expect(res.structuredContent.notReliedOn.length).toBeGreaterThan(0);
    await client.close();
  });

  it('a person approves through an elicitation (multi-round-trip); an agent cannot', async () => {
    const { token } = await desk();
    const agent = await mcpClient(await mcpToken(token));
    const esc = (await agent.callTool({
      name: 'file_exception',
      arguments: { request: buildNorthwind().inbox[6]!.text },
    })) as any;
    const escalationId = esc.structuredContent.escalationId as string;
    const denied = (await agent.callTool({
      name: 'approve_escalation',
      arguments: { escalationId, approve: true },
    })) as any;
    expect(denied.structuredContent.refused).toBe(true);
    await agent.close();

    const tok = await api(token)('/mcp-token', {
      method: 'POST',
      body: JSON.stringify({ principal: 'p-priya' }),
    });
    let asked = '';
    const priya = await mcpClient(tok.body.token, (msg) => {
      asked = msg;
      return { confirm: true, note: 'Renewal signed.' };
    });
    const res = (await priya.callTool({
      name: 'approve_escalation',
      arguments: { escalationId, approve: true },
    })) as any;
    expect(asked).toContain('Paloma Foods');
    expect(res.structuredContent.ok).toBe(true);
    expect(res.structuredContent.outcome).toBe('approved');
    await priya.close();
  });

  it('refuses a missing or forged token', async () => {
    const r = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer stare.eyJ4IjoxfQ.bad' },
      body: '{}',
    });
    expect(r.status).toBe(401);
  });

  it('keeps desk and MCP tokens apart', async () => {
    const { token } = await desk();
    const onMcp = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(onMcp.status).toBe(401);
    const agentToken = await mcpToken(token);
    expect((await api(agentToken)('/overview')).status).toBe(401);
    expect(
      (await api(agentToken)('/mcp-token', { method: 'POST', body: '{"principal":"p-priya"}' })).status,
    ).toBe(401);
  });

  it('serves the standing rules as a SKILL.md resource', async () => {
    const { token } = await desk();
    const client = await mcpClient(await mcpToken(token));
    const res = await client.readResource({ uri: 'stare://skills/standing-rules/SKILL.md' });
    expect(String((res.contents[0] as { text: string }).text)).toMatch(
      /^---\nname: northwind-cloud-exception-desk/,
    );
    await client.close();
    void base;
    void Db;
  });
});
