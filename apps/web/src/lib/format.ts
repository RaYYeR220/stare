import type { Flag, Outcome, PolicyId } from './types';

const MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];

/** Reporter-style dates: "Oct. 16, 2026". */
export function date(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'undated';
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "Oct. 2026", the form used inside a citation's parenthetical. */
export function term(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'undated';
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function time(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(ms: number): string {
  return `${date(ms)}, ${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('en-US');

export function money(v: number): string {
  return usd.format(v);
}

export function count(v: number): string {
  return num.format(v);
}

/** A value in its policy's unit: $1,500 for refunds, 18% for discounts, Net-60 for payment terms. */
export function value(policyId: PolicyId | string | null | undefined, v: number | null | undefined): string {
  if (v == null) return 'none';
  if (policyId === 'refunds' || policyId === 'usd') return usd.format(v);
  if (policyId === 'discounts' || policyId === 'pct') return `${v}%`;
  if (policyId === 'payment_terms' || policyId === 'days') return `Net-${v}`;
  return num.format(v);
}

export function short(hash: string | null | undefined, n = 10): string {
  if (!hash) return 'none';
  return hash.length > n ? hash.slice(0, n) : hash;
}

export const POLICY_NAME: Record<PolicyId, string> = {
  refunds: 'Refund policy',
  discounts: 'Discount policy',
  payment_terms: 'Payment terms policy',
};

export const POLICY_CITE: Record<PolicyId, string> = {
  refunds: 'Refund Pol.',
  discounts: 'Discount Pol.',
  payment_terms: 'Pay. Terms Pol.',
};

export const OUTCOME_STAMP: Record<Outcome, string> = {
  approved: 'Approved',
  counter: 'Counter-offer',
  escalated: 'Escalated',
  denied: 'Denied',
  not_in_graph: 'Not in the graph',
  needs_info: 'Needs information',
};

export const FLAG_NAME: Record<Flag, string> = {
  green: 'Good law',
  yellow: 'Overruling Risk',
  red: 'Not good law',
};

/** Plain-language gloss for the reason codes the standing UDF and the engine return. */
export const CODE_GLOSS: Record<string, string> = {
  OVERTURNED: 'overturned by a later decision',
  RESTS_ON_RED: 'rests on a precedent that is no longer good law',
  SUPERSEDED: 'superseded by the policy now in force',
  NO_AUTHORITY: 'the approver had no authority at the time',
  CONFLICT: 'the approver had a conflict of interest',
  OVERRULING_RISK: 'the only covering precedent is at Overruling Risk',
  NO_PRECEDENT: 'no good-law precedent covers it',
  OVER_DELEGATION: 'covered, but above the agent’s delegation',
  POLICY_LIMIT: 'a hard limit of the policy in force',
  NOT_AUTHORIZED: 'the person acting has no authority for this',
  BUDGET_EXHAUSTED: 'the autonomy budget is spent',
  NO_DELEGATION: 'nobody has delegated this to the agent',
  NO_APPROVER: 'nobody in the reporting line can approve it',
  NOT_IN_GRAPH: 'the account is not in the graph',
  AMBIGUOUS: 'the account name matches more than one customer',
  MISSING_FIELDS: 'the request is missing an amount or a reason',
  UNVERIFIABLE: 'the claim cannot be verified in the graph',
  NOT_OPEN: 'the escalation is no longer open',
};

const REASON: Record<string, string> = {
  outage: 'service outage',
  billing_error: 'billing error',
  duplicate_charge: 'duplicate charge',
  churn_risk: 'churn risk',
  goodwill: 'goodwill',
  competitive: 'competitive match',
  multi_year: 'multi-year commitment',
  expansion: 'seat expansion',
  nonprofit: 'nonprofit',
  public_sector: 'public sector',
  procurement_cycle: 'procurement cycle',
};

export function reason(code: string | null | undefined): string {
  if (!code) return 'no reason given';
  return REASON[code] ?? code.replace(/_/g, ' ');
}

export const AGENT_NAME: Record<string, string> = {
  'a-support': 'Support agent',
  'a-renewals': 'Renewals agent',
  'a-billing': 'Billing agent',
};

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** Capitalise the first letter, for glosses that open a sentence. */
export function sentence(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
