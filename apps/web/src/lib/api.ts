import type {
  AdoptResult,
  Auditor,
  Bottleneck,
  CaseRow,
  Cluster,
  Contact,
  DecideResponse,
  DecisionView,
  ErasureResponse,
  ErasureRow,
  EvalResults,
  Health,
  ImpactReport,
  InboxItem,
  Incoming,
  IsolationProbe,
  LeadingCase,
  LedgerResponse,
  McpToken,
  MemoryItem,
  Overview,
  OverturnResult,
  Person,
  PolicyId,
  PolicyVersion,
  RaceReport,
  RatifyResult,
  ResolveResult,
  RuleView,
  Session,
  Transcript,
} from './types';

export const API_BASE = (process.env.NEXT_PUBLIC_STARE_API ?? 'https://34.52.191.115.sslip.io').replace(/\/+$/, '');

/** A failed call. `expired` means the desk token is gone and a new desk must be opened. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get expired(): boolean {
    return this.status === 401 || this.status === 410;
  }
}

interface RequestOptions {
  body?: unknown;
  token?: string | null;
  /** Non-2xx statuses whose JSON body is still a result (a refusal is an answer, not a failure). */
  accept?: number[];
  signal?: AbortSignal;
  as?: 'json' | 'text';
}

async function request<T>(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('The desk server did not answer. Check your connection and try again.', 0);
  }
  if (!res.ok && !opts.accept?.includes(res.status)) {
    let message = `${res.status} ${res.statusText}`.trim();
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      if (res.status === 502 || res.status === 503) message = 'The desk server is restarting. Try again in a few seconds.';
    }
    throw new ApiError(message, res.status);
  }
  return (opts.as === 'text' ? await res.text() : await res.json()) as T;
}

/** Public endpoints, no desk needed. */
export const publicApi = {
  health: (signal?: AbortSignal) => request<Health>('GET', '/health', { signal }),
  evaluation: (signal?: AbortSignal) => request<EvalResults>('GET', '/eval', { signal }),
  openSession: () => request<Session>('POST', '/session'),
};

/** Every call that needs a desk token. */
export function deskApi(token: string) {
  const get = <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, { token, signal });
  const post = <T>(path: string, body?: unknown, accept?: number[]) => request<T>('POST', path, { token, body: body ?? {}, accept });
  const enc = encodeURIComponent;
  return {
    overview: (s?: AbortSignal) => get<Overview>('/overview', s),
    incoming: (s?: AbortSignal) => get<Incoming[]>('/incoming', s),
    cases: (limit = 40, s?: AbortSignal) => get<CaseRow[]>(`/cases?limit=${limit}`, s),
    people: (s?: AbortSignal) => get<Person[]>('/people', s),
    policies: (s?: AbortSignal) => get<PolicyVersion[]>('/policies', s),
    contacts: (s?: AbortSignal) => get<Contact[]>('/contacts', s),
    inbox: (s?: AbortSignal) => get<InboxItem[]>('/inbox', s),
    decision: (id: string, s?: AbortSignal) => get<DecisionView>(`/decisions/${enc(id)}`, s),
    rules: (s?: AbortSignal) => get<RuleView[]>('/rules', s),
    skill: () => request<string>('GET', '/rules/skill.md', { token, as: 'text' }),
    erasures: (s?: AbortSignal) => get<ErasureRow[]>('/erasures', s),
    isolation: (s?: AbortSignal) => get<IsolationProbe>('/isolation', s),
    ledger: (s?: AbortSignal) => get<LedgerResponse>('/ledger', s),
    leading: (s?: AbortSignal) => get<LeadingCase[]>('/algos/leading', s),
    bottlenecks: (s?: AbortSignal) => get<Bottleneck[]>('/algos/bottlenecks', s),
    clusters: (s?: AbortSignal) => get<Cluster[]>('/algos/clusters', s),
    memory: (q: string, account: string, s?: AbortSignal) =>
      get<MemoryItem[]>(`/memory?q=${enc(q)}${account ? `&account=${enc(account)}` : ''}`, s),
    auditor: (s?: AbortSignal) => get<Auditor>('/auditor', s),

    decide: (text: string, actor: string) => post<DecideResponse>('/decide', { text, actor, ablate: true }),
    handle: (text: string, channel: string, agent?: string) => post<Transcript>('/agents/handle', { text, channel, agent }),
    resolve: (escalationId: string, body: { personId: string; approve: boolean; value?: number; note?: string }) =>
      post<ResolveResult>(`/escalations/${enc(escalationId)}/resolve`, body, [409]),
    overturn: (id: string, personId: string, reason: string) => post<OverturnResult>(`/decisions/${enc(id)}/overturn`, { personId, reason }),
    proposeRules: () => post<{ created: string[] }>('/rules/propose'),
    ratify: (id: string, personId: string) => post<RatifyResult>(`/rules/${enc(id)}/ratify`, { personId }, [409]),
    impact: (policyId: PolicyId, changes: { key: string; value: unknown }[]) => post<ImpactReport>('/policy/impact', { policyId, changes }),
    adopt: (policyId: PolicyId, changes: { key: string; value: unknown }[]) => post<AdoptResult>('/policy/adopt', { policyId, changes }),
    depart: (personId: string) => post<{ ok: boolean; ledgerSeq: number | null }>(`/people/${enc(personId)}/depart`),
    erase: (contactId: string) => post<ErasureResponse>(`/erasure/${enc(contactId)}`),
    race: () => post<RaceReport>('/race'),
    mcpToken: (principal: string) => post<McpToken>('/mcp-token', { principal }),
  };
}

export type DeskApi = ReturnType<typeof deskApi>;

const KEY = 'stare.desk';

/** The visitor's desk, kept in localStorage. Storage can be unavailable (private mode), so every access is guarded. */
export const sessionStore = {
  read(): Session | null {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as Session;
      return typeof s.token === 'string' && typeof s.expiresAt === 'number' ? s : null;
    } catch {
      return null;
    }
  },
  write(s: Session) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // the desk still works for this page view
    }
  },
  clear() {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // nothing to clear
    }
  },
};
