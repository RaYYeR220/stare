import type { FalkorDB } from 'falkordb';
import { Db, type NamedQuery } from './db.ts';
import { decide, type EngineCtx } from './engine/decide.ts';
import type { Intake, Verdict } from './engine/types.ts';
import { verifyLedger } from './ledger.ts';

const q = (name: string, mode: 'ro' | 'rw', doc: string, cypher: string): NamedQuery => ({
  name,
  mode,
  doc,
  cypher: cypher.trim(),
});

export const RACE_QUERIES = {
  accounts: q(
    'race.accounts',
    'ro',
    'Active accounts by tier (to build the burst).',
    `MATCH (a:Account {status:'active'}) RETURN a.name AS name, a.tier AS tier ORDER BY a.name`,
  ),
  budgets: q(
    'race.budgets',
    'ro',
    'Autonomy budgets in force.',
    `MATCH (b:Budget) WHERE b.from <= $now AND $now < b.to RETURN b.id AS id, b.policyId AS policyId, b.unit AS unit, b.cap AS cap, b.remaining AS remaining`,
  ),
  terminal: q(
    'race.terminalPerCase',
    'ro',
    'Invariant: every case in the burst has exactly one outcome (one decision, or one open escalation), never two.',
    `
MATCH (c:Case) WHERE c.key STARTS WITH $prefix
OPTIONAL MATCH (d:Decision)-[:DECIDES]->(c)
OPTIONAL MATCH (e:Escalation)-[:FOR]->(c)
WITH c, count(DISTINCT d) AS decisions, count(DISTINCT e) AS escalations
RETURN count(c) AS cases, sum(CASE WHEN decisions + escalations = 1 THEN 1 ELSE 0 END) AS exactlyOne,
       sum(CASE WHEN decisions > 1 THEN 1 ELSE 0 END) AS doubleDecided`,
  ),
  spent: q(
    'race.spent',
    'ro',
    'What the agents actually granted from the autonomy budget during the burst.',
    `
MATCH (d:Decision)-[:DECIDES]->(c:Case) WHERE c.key STARTS WITH $prefix AND d.basis IN ['precedent', 'rule'] AND d.outcome <> 'denied'
RETURN d.policyId AS policyId, sum(d.value) AS value, count(d) AS n`,
  ),
} as const;

export interface RaceReport {
  requests: number;
  uniqueCases: number;
  connections: number;
  outcomes: Record<string, number>;
  budgets: {
    id: string;
    unit: string;
    before: number;
    after: number;
    spent: number;
    neverNegative: boolean;
    conserved: boolean;
  }[];
  invariants: { name: string; pass: boolean; detail: string }[];
  ledger: { ok: boolean; length: number };
  ms: number;
}

/**
 * A burst of concurrent requests from all three agents against one shared budget, each on its own
 * connection, with duplicates mixed in. Then the invariants are checked in the graph.
 */
export async function runRace(
  ctx: EngineCtx,
  connect: () => Promise<FalkorDB>,
  opts: { n?: number; connections?: number; prefix?: string } = {},
): Promise<RaceReport> {
  const n = opts.n ?? 64;
  const prefix = opts.prefix ?? `race-${Date.now()}-`;
  const now = ctx.clock.now();
  const accounts = await ctx.db.ro<{ name: string; tier: string }>(RACE_QUERIES.accounts);
  const ent = accounts.filter((a) => a.tier === 'enterprise');
  const growthUp = accounts.filter((a) => a.tier !== 'standard');
  const before = await ctx.db.ro<{
    id: string;
    policyId: string;
    unit: string;
    cap: number;
    remaining: number;
  }>(RACE_QUERIES.budgets, { now });

  const reqs: { key: string; agent: string; intake: Intake }[] = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 4;
    let intake: Intake;
    let agent: string;
    if (kind <= 1) {
      agent = 'a-support';
      intake = {
        policyId: 'refunds',
        accountName: ent[i % ent.length]!.name,
        value: 1000 + ((i * 137) % 9) * 100,
        days: 12 + (i % 9),
        reason: 'outage',
        claims: [],
      };
    } else if (kind === 2) {
      agent = 'a-renewals';
      intake = {
        policyId: 'discounts',
        accountName: growthUp[i % growthUp.length]!.name,
        value: 11 + (i % 4),
        days: null,
        reason: 'multi_year',
        claims: [],
      };
    } else {
      agent = 'a-billing';
      intake = {
        policyId: 'payment_terms',
        accountName: growthUp[(i * 7) % growthUp.length]!.name,
        value: 45,
        days: null,
        reason: 'procurement_cycle',
        claims: [],
      };
    }
    // every eighth request is a retry of the previous one: same idempotency key
    const key = i % 8 === 7 ? reqs[i - 1]!.key : `${prefix}${i}`;
    reqs.push({ key, agent, intake: i % 8 === 7 ? reqs[i - 1]!.intake : intake });
    if (i % 8 === 7) reqs[i]!.agent = reqs[i - 1]!.agent;
  }

  const conns = await Promise.all(Array.from({ length: opts.connections ?? 16 }, () => connect()));
  const t0 = performance.now();
  let verdicts: Verdict[];
  try {
    verdicts = await Promise.all(
      reqs.map((r, i) =>
        decide(
          { ...ctx, db: new Db(conns[i % conns.length]!, ctx.db.graphName) },
          { principal: { kind: 'agent', id: r.agent }, intake: r.intake, key: r.key },
        ),
      ),
    );
  } finally {
    await Promise.all(conns.map((c) => c.close().catch(() => {})));
  }
  const ms = Math.round(performance.now() - t0);

  const outcomes: Record<string, number> = {};
  for (const v of verdicts) {
    const k =
      v.refusal?.code === 'REPLAY'
        ? 'replayed'
        : v.refusal?.code === 'BUDGET_EXHAUSTED'
          ? 'escalated: budget'
          : v.outcome;
    outcomes[k] = (outcomes[k] ?? 0) + 1;
  }
  const after = await ctx.db.ro<{ id: string; remaining: number }>(RACE_QUERIES.budgets, { now });
  const spent = await ctx.db.ro<{ policyId: string; value: number; n: number }>(RACE_QUERIES.spent, {
    prefix,
  });
  const budgets = before.map((b) => {
    const a = after.find((x) => x.id === b.id)!;
    const s = spent.find((x) => x.policyId === b.policyId);
    const used = b.unit === 'count' ? (s?.n ?? 0) : (s?.value ?? 0);
    return {
      id: b.id,
      unit: b.unit,
      before: b.remaining,
      after: a.remaining,
      spent: used,
      neverNegative: a.remaining >= 0,
      conserved: b.remaining - a.remaining === used,
    };
  });
  const [term] = await ctx.db.ro<{ cases: number; exactlyOne: number; doubleDecided: number }>(
    RACE_QUERIES.terminal,
    { prefix },
  );
  const ledger = await verifyLedger(ctx.db, { deep: true });
  const uniqueCases = new Set(reqs.map((r) => r.key)).size;
  const invariants = [
    {
      name: 'No budget ever goes negative',
      pass: budgets.every((b) => b.neverNegative),
      detail: budgets.map((b) => `${b.id}: ${b.before} → ${b.after}`).join('; '),
    },
    {
      name: 'Budget spent equals what was granted (no lost updates)',
      pass: budgets.every((b) => b.conserved),
      detail: budgets.map((b) => `${b.id}: spent ${b.spent}`).join('; '),
    },
    {
      name: 'Every case has exactly one outcome; none decided twice',
      pass:
        !!term && term.cases === uniqueCases && term.exactlyOne === term.cases && term.doubleDecided === 0,
      detail: `${term?.exactlyOne ?? 0}/${uniqueCases} cases, ${term?.doubleDecided ?? 0} double-decided`,
    },
    {
      name: 'Retries with the same key return the original outcome',
      pass: (outcomes.replayed ?? 0) + uniqueCases >= reqs.length,
      detail: `${outcomes.replayed ?? 0} replays of ${reqs.length - uniqueCases} retries (others raced and were merged by the case key)`,
    },
    {
      name: 'Ledger has no fork and matches every decision',
      pass: ledger.ok,
      detail: ledger.ok ? `${ledger.length} entries` : String(ledger.reason),
    },
  ];
  return {
    requests: reqs.length,
    uniqueCases,
    connections: conns.length,
    outcomes,
    budgets,
    invariants,
    ledger: { ok: ledger.ok, length: ledger.length },
    ms,
  };
}
