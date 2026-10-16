import type {
  ClauseRow,
  DecisionRow,
  DelegationRow,
  GrantRow,
  HoldsRow,
  OwnsRow,
  PolicyId,
  Tier,
  VersionRow,
} from './model.ts';

export const TIER_RANK: Record<Tier, number> = { standard: 1, growth: 2, enterprise: 3 };

const inside = (r: { validFrom: number; validTo: number }, t: number) => r.validFrom <= t && t < r.validTo;

function evalOp(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case 'lte':
      return (actual as number) <= (expected as number);
    case 'lt':
      return (actual as number) < (expected as number);
    case 'gte':
      return (actual as number) >= (expected as number);
    case 'gt':
      return (actual as number) > (expected as number);
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'in':
      return (expected as unknown[]).includes(actual);
    case 'nin':
      return !(expected as unknown[]).includes(actual);
    default:
      return true;
  }
}

/**
 * The organisation's rules as plain data, used while generating history so every synthetic
 * decision is made by someone who really could make it at that moment. `standing` here is an
 * independent TypeScript re-implementation of the database UDF; the seed test checks the two agree.
 */
export class World {
  constructor(
    private holds: HoldsRow[],
    private grants: GrantRow[],
    private owns: OwnsRow[],
    private delegations: DelegationRow[],
    private versions: VersionRow[],
    private clauses: ClauseRow[],
  ) {}

  capAt(person: string, policy: PolicyId, t: number): number {
    let cap = 0;
    for (const h of this.holds) {
      if (h.person !== person || !inside(h, t)) continue;
      for (const g of this.grants)
        if (g.role === h.role && g.policy === policy && inside(g, t)) cap = Math.max(cap, g.cap);
    }
    return cap;
  }

  ownsAt(person: string, account: string, t: number): boolean {
    return this.owns.some((o) => o.person === person && o.account === account && inside(o, t));
  }

  delegationAt(agent: string, policy: PolicyId, t: number): { person: string; cap: number } | null {
    let best: { person: string; cap: number } | null = null;
    for (const d of this.delegations) {
      if (d.agent !== agent || d.policyId !== policy || !inside(d, t)) continue;
      if (this.capAt(d.person, policy, t) < d.cap) continue; // delegator must hold the authority they delegate
      if (!best || d.cap > best.cap) best = { person: d.person, cap: d.cap };
    }
    return best;
  }

  delegationCapOf(person: string, agent: string, policy: PolicyId, t: number): number {
    let cap = 0;
    for (const d of this.delegations)
      if (d.person === person && d.agent === agent && d.policyId === policy && inside(d, t))
        cap = Math.max(cap, d.cap);
    return cap;
  }

  versionAt(policy: PolicyId, t: number): VersionRow {
    const v = this.versions.filter((x) => x.policyId === policy && x.effectiveFrom <= t && t < x.effectiveTo);
    if (!v.length) throw new Error(`no ${policy} version at ${new Date(t).toISOString()}`);
    return v.sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0]!;
  }

  violations(facts: Record<string, unknown>, versionId: string) {
    const res = { limit: [] as ClauseRow[], default: [] as ClauseRow[] };
    for (const c of this.clauses) {
      if (c.versionId !== versionId) continue;
      const v = facts[c.rule.field];
      if (v === undefined || v === null || !evalOp(v, c.rule.op, c.rule.value)) res[c.kind].push(c);
    }
    return res;
  }

  /** Mirror of stare.covers. */
  covers(
    p: DecisionRow,
    f: { policyId: PolicyId; reason: string; tier: Tier; days: number | null; value: number },
  ) {
    const pf = p.facts as { reason: string; tier: Tier; days?: number | null };
    const no = { covers: false, partial: false };
    if (p.policyId !== f.policyId || pf.reason !== f.reason) return no;
    if (TIER_RANK[f.tier] < TIER_RANK[pf.tier]) return no;
    const fd = f.days ?? undefined;
    const pd = pf.days ?? undefined;
    if (fd !== undefined || pd !== undefined) {
      if (typeof fd !== 'number' || typeof pd !== 'number' || fd > pd) return no;
    }
    if (p.outcome !== 'approved' && p.outcome !== 'counter') return no;
    return f.value <= p.value ? { covers: true, partial: false } : { covers: false, partial: true };
  }

  /** Mirror of stare.standing over generated rows. */
  standing(
    id: string,
    t: number,
    byId: Map<string, DecisionRow>,
    overturnsOf: Map<string, DecisionRow[]>,
    memo = new Map<string, { flag: string; chain: string[] }>(),
    stack = new Set<string>(),
    depth = 0,
  ): { flag: 'green' | 'yellow' | 'red'; chain: string[]; codes: string[] } {
    const hit = memo.get(id);
    if (hit) return hit as any;
    if (stack.has(id) || depth > 12) return { flag: 'yellow', chain: [], codes: ['UNVERIFIABLE'] };
    stack.add(id);
    const d = byId.get(id)!;
    const codes: string[] = [];
    if ((overturnsOf.get(id) ?? []).some((o) => o.at <= t)) codes.push('OVERTURNED');
    const facts = { ...d.facts, value: d.value, policyId: d.policyId };
    let person = d.madeBy;
    if (d.madeBy.startsWith('a-')) {
      if (!d.onAuthorityOf) codes.push('NO_AUTHORITY');
      else {
        person = d.onAuthorityOf;
        if (this.delegationCapOf(person, d.madeBy, d.policyId, d.at) < d.value) codes.push('NO_AUTHORITY');
      }
    }
    const routine = this.violations(facts, d.policyVersionId).default.length === 0;
    if (!routine && !codes.includes('NO_AUTHORITY')) {
      if (this.capAt(person, d.policyId, d.at) < d.value) codes.push('NO_AUTHORITY');
      if (this.ownsAt(person, d.accountId, d.at)) codes.push('CONFLICT');
    }
    const cur = this.versionAt(d.policyId, t);
    if (cur.id !== d.policyVersionId && this.violations(facts, cur.id).limit.length) codes.push('SUPERSEDED');
    let res: { flag: 'green' | 'yellow' | 'red'; chain: string[]; codes: string[] };
    if (codes.length) res = { flag: 'red', chain: [], codes };
    else {
      res = { flag: 'green', chain: [], codes: [] };
      for (const c of d.cites) {
        const s = this.standing(c.id, t, byId, overturnsOf, memo, stack, depth + 1);
        if (s.flag !== 'green') {
          const chain = [c.id, ...s.chain];
          if (res.flag === 'green' || chain.length < res.chain.length)
            res = { flag: 'yellow', chain, codes: ['RESTS_ON_RED'] };
        }
      }
    }
    stack.delete(id);
    memo.set(id, res);
    return res;
  }
}
