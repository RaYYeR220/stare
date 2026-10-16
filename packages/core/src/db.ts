import { FalkorDB } from 'falkordb';

export type Params = Record<string, unknown>;

/** A query from the catalog. The model never writes Cypher; every query the product runs has a name. */
export interface NamedQuery {
  name: string;
  mode: 'ro' | 'rw';
  cypher: string;
  /** One line for docs/queries.md and the "Cypher that ran" panel. */
  doc: string;
}

export interface QueryLogEntry {
  name: string;
  mode: 'ro' | 'rw';
  cypher: string;
  params: Params;
  ms: number;
  rows: number;
  stats?: Record<string, string>;
}

/** Collects every query a request ran, so the trace can show the exact Cypher. */
export class QueryRecorder {
  readonly entries: QueryLogEntry[] = [];
  push(e: QueryLogEntry) {
    this.entries.push(e);
  }
}

export interface ConnectOptions {
  url: string;
  username?: string;
  password?: string;
  /** Long-lived connections reconnect with backoff; short-lived ones (probes, tests) fail fast. */
  reconnect?: boolean;
}

export async function connect(opts: ConnectOptions): Promise<FalkorDB> {
  const u = new URL(opts.url.replace(/^falkors?:/, 'redis:'));
  const tls = opts.url.startsWith('falkors:');
  const client = await FalkorDB.connect({
    socket: {
      host: u.hostname,
      port: Number(u.port || 6379),
      ...(tls ? { tls: true } : {}),
      reconnectStrategy: opts.reconnect ? (retries: number) => Math.min(250 * 2 ** retries, 5000) : false,
    } as any,
    username: opts.username || decodeURIComponent(u.username) || undefined,
    password: opts.password || decodeURIComponent(u.password) || undefined,
  });
  // Connection errors surface on the next query; without a listener they would crash the process.
  client.on('error', (e: Error) => {
    if (opts.reconnect) console.warn(`[stare] falkordb connection: ${e.message}`);
  });
  return client;
}

function parseStats(metadata: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(metadata)) return out;
  for (const line of metadata) {
    if (typeof line !== 'string') continue;
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function toNamed(q: NamedQuery | string, mode: 'ro' | 'rw'): NamedQuery {
  return typeof q === 'string' ? { name: 'adhoc', mode, cypher: q, doc: '' } : q;
}

/** A handle on one graph (one tenant) through one connection (one ACL user). */
export class Db {
  constructor(
    readonly client: FalkorDB,
    readonly graphName: string,
    readonly recorder?: QueryRecorder,
  ) {}

  get graph() {
    return this.client.selectGraph(this.graphName);
  }

  withRecorder(recorder: QueryRecorder): Db {
    return new Db(this.client, this.graphName, recorder);
  }

  forGraph(graphName: string): Db {
    return new Db(this.client, graphName, this.recorder);
  }

  async ro<T = Record<string, unknown>>(q: NamedQuery | string, params: Params = {}): Promise<T[]> {
    const nq = toNamed(q, 'ro');
    if (nq.mode !== 'ro') throw new Error(`query ${nq.name} is not read-only`);
    const t0 = performance.now();
    const res = await this.graph.roQuery<T>(nq.cypher, { params: params as any });
    const rows = (res.data ?? []) as T[];
    this.recorder?.push({
      name: nq.name,
      mode: 'ro',
      cypher: nq.cypher,
      params,
      ms: performance.now() - t0,
      rows: rows.length,
    });
    return rows;
  }

  async rw<T = Record<string, unknown>>(
    q: NamedQuery | string,
    params: Params = {},
  ): Promise<{ rows: T[]; stats: Record<string, string> }> {
    const nq = toNamed(q, 'rw');
    const t0 = performance.now();
    const res = await this.graph.query<T>(nq.cypher, { params: params as any });
    const rows = (res.data ?? []) as T[];
    const stats = parseStats((res as any).metadata);
    this.recorder?.push({
      name: nq.name,
      mode: 'rw',
      cypher: nq.cypher,
      params,
      ms: performance.now() - t0,
      rows: rows.length,
      stats,
    });
    return { rows, stats };
  }
}

/** Raw redis connection for admin commands (ACL, GRAPH.COPY, UDF). Never handed to tenant code. */
export async function rawCommand(client: FalkorDB, args: string[]): Promise<unknown> {
  const conn = await client.connection;
  return conn.sendCommand(args);
}
