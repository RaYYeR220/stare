import { beforeAll, describe, expect, it } from 'vitest';
import { approvalBottlenecks, exceptionClusters, leadingCases, precedentFamilies } from '../src/algos.ts';
import { copyGraph } from '../src/copy.ts';
import { connect, Db } from '../src/db.ts';
import { ablate } from '../src/engine/ablate.ts';
import { decide } from '../src/engine/decide.ts';
import { acceptHandoff, handoff, handoffInbox, lastEpisode, recall, remember } from '../src/memory.ts';
import { runRace } from '../src/race.ts';
import {
  createSandbox,
  dropSandbox,
  probeIsolation,
  provisionTenantUser,
  sweepSandboxes,
} from '../src/tenancy.ts';
import { adminClient, TEST_URL } from './helpers.ts';
import { ctxOn, inbox, NOW, northwindBase, nw } from './northwind.ts';

let base: string;
beforeAll(async () => {
  base = await northwindBase('plat');
}, 120_000);

describe('tenancy enforced by the database', () => {
  it('a sandbox user reads its own copy and gets NOPERM everywhere else, logged in ACL LOG', async () => {
    const admin = await adminClient();
    const sbx = await createSandbox(admin, base, 60_000);
    const probe = await probeIsolation(admin, TEST_URL, sbx, base);
    expect(probe.ownGraph.ok).toBe(true);
    expect(probe.ownGraph.rows).toBeGreaterThan(1000);
    for (const a of probe.attempts) expect(a.error, a.command).toMatch(/NOPERM/);
    expect(probe.aclLog.some((e) => e.reason === 'key' && e.object === base)).toBe(true);
    expect(probe.aclLog.some((e) => e.reason === 'command' && /graph\.UDF/i.test(e.object))).toBe(true);
    await dropSandbox(admin, sbx.id);
    expect((await admin.list()).includes(sbx.graph)).toBe(false);
  });

  it('expired sandboxes are swept', async () => {
    const admin = await adminClient();
    const sbx = await createSandbox(admin, base, 1, NOW);
    expect(await sweepSandboxes(admin, NOW + 10)).toBeGreaterThanOrEqual(1);
    expect((await admin.list()).includes(sbx.graph)).toBe(false);
  });

  it('the engine runs entirely as the tenant user', async () => {
    const admin = await adminClient();
    const sbx = await createSandbox(admin, base, 60_000);
    const client = await connect({ url: TEST_URL, username: sbx.user, password: sbx.password });
    const ctx = await ctxOn(base);
    const v = await decide({ ...ctx, db: new Db(client, sbx.graph) }, inbox('in-acme-outage'));
    expect(v.outcome).toBe('counter');
    expect(v.decisionId).toBeTruthy();
    await client.close();
    await dropSandbox(admin, sbx.id);
  });

  it('a read-only tenant user cannot write even to its own graph', async () => {
    const admin = await adminClient();
    const tenant = `ro${Date.now() % 100000}`;
    await copyGraph(admin, base, `stare:${tenant}`);
    const ro = await provisionTenantUser(admin, tenant, { readOnly: true });
    const client = await connect({ url: TEST_URL, username: ro.user, password: ro.password });
    const rows = await new Db(client, ro.graph).ro<{ n: number }>('MATCH (d:Decision) RETURN count(d) AS n');
    expect(rows[0]!.n).toBeGreaterThan(100);
    await expect(client.selectGraph(ro.graph).query('CREATE (:X)')).rejects.toThrow(/NOPERM/);
    await client.close();
    await admin.selectGraph(ro.graph).delete();
  });
});

describe('concurrency', () => {
  it('64 concurrent requests from three agents on 16 connections keep every invariant', async () => {
    const ctx = await ctxOn(base);
    const report = await runRace(ctx, () => connect({ url: TEST_URL }), { n: 64, connections: 16 });
    for (const inv of report.invariants) expect(inv.pass, `${inv.name}: ${inv.detail}`).toBe(true);
    expect(report.outcomes['escalated: budget'] ?? 0).toBeGreaterThan(0);
    expect(report.outcomes.approved).toBeGreaterThan(0);
  }, 120_000);
});

describe('graph algorithms as tools', () => {
  it('leading cases, bottlenecks, clusters, families', async () => {
    const ctx = await ctxOn(base);
    const lead = await leadingCases(ctx.db, NOW, 5);
    expect(lead.length).toBe(5);
    expect(lead[0]!.followers).toBeGreaterThan(0);
    expect(['green', 'yellow', 'red']).toContain(lead[0]!.standing.flag);
    const bottle = await approvalBottlenecks(ctx.db, NOW);
    expect(bottle.length).toBeGreaterThan(0);
    const clusters = await exceptionClusters(ctx.db, NOW);
    expect(clusters.length).toBeGreaterThan(1);
    const fam = await precedentFamilies(ctx.db);
    expect(fam[0]!.size).toBeGreaterThan(2);
  });
});

describe('agent memory', () => {
  it('episodes persist across sessions, are shared across agents, and expand through the account', async () => {
    const ctx = await ctxOn(base);
    const id = await remember(ctx.db, ctx.embedder, {
      agentId: 'a-support',
      sessionId: 's-1',
      summary: 'Acme Logistics asked for an outage refund; countered at $1,200 on Fernway Travel.',
      about: ['acc-acmelogistics'],
      now: NOW,
    });
    expect((await lastEpisode(ctx.db, 'a-support'))!.id).toBe(id);
    const items = await recall(ctx.db, ctx.embedder, {
      query: 'what did we do for Acme Logistics last time?',
      account: 'Acme Logistics',
    });
    expect(items.some((i) => i.id === id)).toBe(true);
    expect(items.some((i) => i.kind === 'fact' && i.text.includes('credit notes'))).toBe(true);
  });

  it('handoffs travel between agents', async () => {
    const ctx = await ctxOn(base);
    const id = await handoff(ctx.db, {
      from: 'a-support',
      to: 'a-renewals',
      note: 'They want a discount, not a refund.',
      now: NOW,
    });
    expect((await handoffInbox(ctx.db, 'a-renewals')).map((h) => h.id)).toContain(id);
    expect(await acceptHandoff(ctx.db, id, 'a-renewals', NOW)).toBe(true);
    expect((await handoffInbox(ctx.db, 'a-renewals')).map((h) => h.id)).not.toContain(id);
  });
});

describe('structure off (ablation)', () => {
  it('a vector-only agent follows the nearest approved decision, whatever its standing', async () => {
    const ctx = await ctxOn(base);
    const a = await ablate(ctx, inbox('in-acme-outage'));
    expect(a.precedent).not.toBeNull();
    expect(['approved', 'counter']).toContain(a.outcome);
    expect(a.ignored.length).toBeGreaterThan(3);
    void nw;
  });
});
