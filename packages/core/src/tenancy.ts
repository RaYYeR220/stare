import { randomBytes } from 'node:crypto';
import type { FalkorDB } from 'falkordb';
import { copyGraph } from './copy.ts';
import { connect, rawCommand } from './db.ts';

/** Commands a tenant connection needs. Never GRAPH.UDF, GRAPH.LIST, GRAPH.COPY or GRAPH.DELETE. */
export const TENANT_COMMANDS = ['-@all', '+GRAPH.QUERY', '+GRAPH.RO_QUERY', '+info', '+ping', '+client|setinfo', '+hello'];
export const READONLY_COMMANDS = ['-@all', '+GRAPH.RO_QUERY', '+info', '+ping', '+client|setinfo', '+hello'];

export const graphOf = (tenant: string) => `stare:${tenant}`;
export const templateOf = (tenant: string) => `stare:tpl:${tenant}`;
const SANDBOX_PREFIX = 'stare:sbx:';
const REGISTRY = 'stare:sandboxes';

const slug = /^[a-z0-9-]{2,40}$/;

export interface Credentials {
  user: string;
  password: string;
  graph: string;
}

/**
 * One ACL user per tenant, limited by key pattern to that tenant's graph (and its what-if copies).
 * The database itself refuses any other graph: NOPERM, logged in ACL LOG.
 */
export async function provisionTenantUser(admin: FalkorDB, tenant: string, opts: { readOnly?: boolean; password?: string; user?: string } = {}): Promise<Credentials> {
  if (!slug.test(tenant)) throw new Error(`bad tenant id ${tenant}`);
  const user = opts.user ?? `${opts.readOnly ? 'ro' : 't'}_${tenant}`;
  const password = opts.password ?? randomBytes(24).toString('hex');
  const graph = graphOf(tenant);
  await rawCommand(admin, ['ACL', 'SETUSER', user, 'reset', 'on', `>${password}`, 'resetkeys', `~${graph}`, `~${graph}:*`, ...(opts.readOnly ? READONLY_COMMANDS : TENANT_COMMANDS)]);
  return { user, password, graph };
}

export interface Sandbox extends Credentials {
  id: string;
  expiresAt: number;
}

/**
 * A private, disposable copy of a tenant for one visitor: GRAPH.COPY of the pristine template plus an
 * ACL user that can reach only that copy. Visitors can approve, overturn, change policy and erase
 * without touching anyone else's data.
 */
export async function createSandbox(admin: FalkorDB, template: string, ttlMs: number, now = Date.now()): Promise<Sandbox> {
  const id = randomBytes(6).toString('hex');
  const graph = `${SANDBOX_PREFIX}${id}`;
  await copyGraph(admin, template, graph);
  const user = `s_${id}`;
  const password = randomBytes(24).toString('hex');
  await rawCommand(admin, ['ACL', 'SETUSER', user, 'reset', 'on', `>${password}`, 'resetkeys', `~${graph}`, `~${graph}:*`, ...TENANT_COMMANDS]);
  const expiresAt = now + ttlMs;
  await rawCommand(admin, ['HSET', REGISTRY, id, String(expiresAt)]);
  return { id, user, password, graph, expiresAt };
}

export async function dropSandbox(admin: FalkorDB, id: string): Promise<void> {
  const graph = `${SANDBOX_PREFIX}${id}`;
  for (const g of await admin.list()) if (g === graph || g.startsWith(`${graph}:`)) await admin.selectGraph(g).delete().catch(() => {});
  await rawCommand(admin, ['ACL', 'DELUSER', `s_${id}`]).catch(() => {});
  await rawCommand(admin, ['HDEL', REGISTRY, id]);
}

/** Drops every sandbox past its TTL. Returns how many were removed. */
export async function sweepSandboxes(admin: FalkorDB, now = Date.now()): Promise<number> {
  const flat = (await rawCommand(admin, ['HGETALL', REGISTRY])) as string[] | Record<string, string>;
  const entries: [string, string][] = Array.isArray(flat) ? flat.flatMap((v, i, a) => (i % 2 ? [] : [[v, a[i + 1]!] as [string, string]])) : Object.entries(flat);
  let n = 0;
  for (const [id, exp] of entries) {
    if (Number(exp) <= now) {
      await dropSandbox(admin, id);
      n++;
    }
  }
  return n;
}

export interface IsolationProbe {
  ownGraph: { graph: string; ok: boolean; rows: number };
  attempts: { graph: string; command: string; error: string | null }[];
  aclLog: { reason: string; object: string; username: string; ageSeconds: number }[];
}

/**
 * Proves isolation from the database's side: as the tenant's own ACL user, read its graph, then try to
 * read and write another tenant's graph and to run the admin commands it must never have. Every refusal
 * is FalkorDB's verbatim error, and the ACL LOG entries are read back with the admin connection.
 */
export async function probeIsolation(admin: FalkorDB, url: string, creds: Credentials, otherGraph: string): Promise<IsolationProbe> {
  await rawCommand(admin, ['ACL', 'LOG', 'RESET']).catch(() => {});
  const client = await connect({ url, username: creds.user, password: creds.password });
  const attempts: IsolationProbe['attempts'] = [];
  const attempt = async (graph: string, command: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      attempts.push({ graph, command, error: null });
    } catch (e) {
      attempts.push({ graph, command, error: String((e as Error).message) });
    }
  };
  let rows = 0;
  let ok = false;
  try {
    const r = await client.selectGraph(creds.graph).roQuery('MATCH (n) RETURN count(n) AS n');
    rows = Number((r.data?.[0] as { n: number } | undefined)?.n ?? 0);
    ok = true;
  } catch {
    ok = false;
  }
  await attempt(otherGraph, 'GRAPH.RO_QUERY', () => client.selectGraph(otherGraph).roQuery('MATCH (n) RETURN count(n)'));
  await attempt(otherGraph, 'GRAPH.QUERY', () => client.selectGraph(otherGraph).query("CREATE (:Intrusion {at: timestamp()})"));
  await attempt('*', 'GRAPH.LIST', () => client.list());
  await attempt(creds.graph, 'GRAPH.COPY', () => client.selectGraph(creds.graph).copy(otherGraph));
  await attempt('*', 'GRAPH.UDF LOAD', () => client.udfLoad('x', 'falkor.register("x", function () { return 1; })', true));
  await client.close();
  const raw = (await rawCommand(admin, ['ACL', 'LOG', '20'])) as unknown[][];
  const aclLog = raw
    .map((e) => {
      const o: Record<string, unknown> = {};
      for (let i = 0; i < e.length; i += 2) o[String(e[i])] = e[i + 1];
      return { reason: String(o.reason), object: String(o.object), username: String(o.username), ageSeconds: Number(o['age-seconds']) };
    })
    .filter((e) => e.username === creds.user);
  return { ownGraph: { graph: creds.graph, ok, rows }, attempts, aclLog };
}
