import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  connect, createSandbox, Db, dropSandbox, type EngineCtx, type Principal, rawCommand, sweepSandboxes, systemClock, templateOf,
} from '@stare/core';
import { CachedEmbedder, modelsFromEnv } from '@stare/llm';
import type { FalkorDB } from 'falkordb';

export interface Config {
  falkorUrl: string;
  adminUser?: string;
  adminPassword?: string;
  tokenSecret: string;
  publicUrl: string;
  sandboxTtlMs: number;
  maxSandboxes: number;
  port: number;
  embedCache: string;
}

export function configFromEnv(env = process.env): Config {
  return {
    falkorUrl: env.FALKORDB_URL ?? 'falkor://127.0.0.1:6390',
    adminUser: env.FALKORDB_ADMIN_USER || undefined,
    adminPassword: env.FALKORDB_ADMIN_PASSWORD || undefined,
    tokenSecret: env.STARE_TOKEN_SECRET ?? randomBytes(32).toString('hex'),
    publicUrl: env.STARE_PUBLIC_URL ?? 'http://127.0.0.1:8787',
    sandboxTtlMs: Number(env.STARE_SANDBOX_TTL_MS ?? 2 * 3600e3),
    maxSandboxes: Number(env.STARE_MAX_SANDBOXES ?? 150),
    port: Number(env.PORT ?? 8787),
    embedCache: env.STARE_EMBED_CACHE ?? fileURLToPath(new URL('../../seed/data/embeddings.json', import.meta.url)),
  };
}

// ------------------------------------------------------------------ tokens

/** What a bearer token grants: one sandbox (or tenant) graph, acting as one principal. */
export interface Grant {
  sbx: string;
  principal: Principal;
  exp: number;
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');

export function signToken(secret: string, g: Grant): string {
  const body = b64(JSON.stringify(g));
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `stare.${body}.${mac}`;
}

export function verifyToken(secret: string, token: string | undefined | null, now = Date.now()): Grant | null {
  if (!token) return null;
  const [p, body, mac] = token.split('.');
  if (p !== 'stare' || !body || !mac) return null;
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const g = JSON.parse(Buffer.from(body, 'base64url').toString()) as Grant;
    if (typeof g.exp !== 'number' || g.exp <= now) return null;
    if (!/^[a-f0-9]{12}$/.test(g.sbx)) return null;
    if (!g.principal || !['agent', 'person'].includes(g.principal.kind) || !/^[a-z]-[a-z0-9-]+$/.test(g.principal.id)) return null;
    return g;
  } catch {
    return null;
  }
}

export function bearer(h: string | undefined | null): string | null {
  const m = h?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1]! : null;
}

// ------------------------------------------------------------------ runtime

interface SandboxConn {
  graph: string;
  user: string;
  password: string;
  expiresAt: number;
  client?: FalkorDB;
}

const REGISTRY = 'stare:sandbox-creds';

/**
 * Owns the admin connection (provisioning only) and one connection per sandbox, made as that sandbox's
 * ACL user. Tool handlers and routes only ever receive the sandbox connection.
 */
export class Runtime {
  admin!: FalkorDB;
  readonly models = modelsFromEnv();
  readonly embedder;
  private sandboxes = new Map<string, SandboxConn>();
  private sweeper?: NodeJS.Timeout;

  constructor(readonly cfg: Config) {
    this.embedder = new CachedEmbedder(this.models.offline ? null : this.models.embedder, cfg.embedCache, 'text-embedding-qwen3-0-6b', 512);
  }

  async start() {
    this.admin = await connect({ url: this.cfg.falkorUrl, username: this.cfg.adminUser, password: this.cfg.adminPassword });
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
  }

  async stop() {
    clearInterval(this.sweeper);
    for (const s of this.sandboxes.values()) await s.client?.close().catch(() => {});
    await this.admin?.close().catch(() => {});
  }

  async sweep() {
    await sweepSandboxes(this.admin).catch(() => 0);
    const now = Date.now();
    for (const [id, s] of this.sandboxes) {
      if (s.expiresAt <= now) {
        await s.client?.close().catch(() => {});
        this.sandboxes.delete(id);
        await rawCommand(this.admin, ['HDEL', REGISTRY, id]).catch(() => {});
      }
    }
  }

  async activeSandboxes(): Promise<number> {
    return Number(await rawCommand(this.admin, ['HLEN', 'stare:sandboxes']).catch(() => 0));
  }

  async openSandbox(tenant = 'northwind'): Promise<{ id: string; expiresAt: number }> {
    if ((await this.activeSandboxes()) >= this.cfg.maxSandboxes) throw new Error('the desk is full right now; try again in a few minutes');
    const s = await createSandbox(this.admin, templateOf(tenant), this.cfg.sandboxTtlMs);
    this.sandboxes.set(s.id, { graph: s.graph, user: s.user, password: s.password, expiresAt: s.expiresAt });
    await rawCommand(this.admin, ['HSET', REGISTRY, s.id, JSON.stringify({ graph: s.graph, user: s.user, password: s.password, expiresAt: s.expiresAt })]);
    return { id: s.id, expiresAt: s.expiresAt };
  }

  async closeSandbox(id: string) {
    const s = this.sandboxes.get(id);
    await s?.client?.close().catch(() => {});
    this.sandboxes.delete(id);
    await dropSandbox(this.admin, id);
    await rawCommand(this.admin, ['HDEL', REGISTRY, id]).catch(() => {});
  }

  async sandbox(id: string): Promise<SandboxConn | null> {
    let s = this.sandboxes.get(id);
    if (!s) {
      const raw = (await rawCommand(this.admin, ['HGET', REGISTRY, id]).catch(() => null)) as string | null;
      if (!raw) return null;
      s = JSON.parse(raw) as SandboxConn;
      this.sandboxes.set(id, s);
    }
    if (s.expiresAt <= Date.now()) return null;
    if (!s.client) s.client = await connect({ url: this.cfg.falkorUrl, username: s.user, password: s.password });
    return s;
  }

  /** Engine context bound to the sandbox's own ACL connection. */
  async ctx(id: string): Promise<EngineCtx | null> {
    const s = await this.sandbox(id);
    if (!s) return null;
    return { db: new Db(s.client!, s.graph), llm: this.models.llm, embedder: this.embedder, clock: systemClock, modelExplanations: !this.models.offline };
  }

  sandboxCreds(id: string) {
    const s = this.sandboxes.get(id);
    return s ? { user: s.user, password: s.password, graph: s.graph } : null;
  }

  token(sbx: string, principal: Principal, ttlMs = this.cfg.sandboxTtlMs): string {
    return signToken(this.cfg.tokenSecret, { sbx, principal, exp: Date.now() + ttlMs });
  }

  grant(token: string | null): Grant | null {
    return verifyToken(this.cfg.tokenSecret, token);
  }
}
