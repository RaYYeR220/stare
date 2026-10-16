import type { PolicyId } from './model.ts';
import type { Rng } from './rng.ts';

export const CHANNEL: Record<PolicyId, string> = {
  refunds: '#support-escalations',
  discounts: '#deal-desk',
  payment_terms: '#billing-ops',
};

export const REASON_LABEL: Record<string, string> = {
  outage: 'service outage',
  billing_error: 'billing error',
  churn_risk: 'churn risk',
  duplicate_charge: 'duplicate charge',
  goodwill: 'goodwill',
  competitive: 'competitive match',
  multi_year: 'multi-year commitment',
  expansion: 'seat expansion',
  nonprofit: 'nonprofit rate',
  procurement_cycle: 'procurement cycle',
  public_sector: 'public-sector statute',
  cash_flow: 'cash flow',
};

export const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

export function fmtValue(policy: PolicyId, v: number): string {
  if (policy === 'refunds') return usd(v);
  if (policy === 'discounts') return `${v}%`;
  return `Net-${v}`;
}

interface Ctx {
  account: string;
  contact: string;
  value: number;
  days: number | null;
  incident?: string;
  hours?: number;
}

const REQ: Record<string, Array<(c: Ctx, r: Rng) => string>> = {
  outage: [
    (c) =>
      `${c.contact} at ${c.account} is asking for a ${usd(c.value)} refund for the ${c.incident ?? 'outage'} — they lost about ${c.hours ?? 6} hours of ingest. Charge was ${c.days} days ago.`,
    (c) =>
      `Refund ask from ${c.account}: ${usd(c.value)}. ${c.contact} says the ${c.incident ?? 'outage'} broke their nightly loads. ${c.days} days since the invoice.`,
    (c) =>
      `Can we refund ${c.account} ${usd(c.value)}? They were down during the ${c.incident ?? 'incident'}; ${c.contact} sent the timeline. Charge is ${c.days} days old.`,
  ],
  billing_error: [
    (c, r) =>
      `${c.account} was billed for ${r.int(40, 90)} seats instead of ${r.int(20, 39)} on the last invoice. ${c.contact} wants ${usd(c.value)} back. ${c.days} days since the charge.`,
    (c) =>
      `Invoice mistake on ${c.account}: wrong price book applied. ${c.contact} is asking for ${usd(c.value)}. Charged ${c.days} days ago.`,
  ],
  churn_risk: [
    (c) =>
      `${c.contact} from ${c.account} says they'll walk at renewal unless we refund ${usd(c.value)} of last quarter. It's ${c.days} days since the charge. Worth it?`,
    (c) =>
      `${c.account} is wobbling. ${c.contact} wants ${usd(c.value)} back as a show of good faith before the renewal call. ${c.days} days.`,
  ],
  duplicate_charge: [
    (c) =>
      `${c.account} got double-charged in the billing run. ${c.contact} flagged it. ${usd(c.value)} to refund, ${c.days} days ago.`,
    (c) => `Duplicate charge on ${c.account}, ${usd(c.value)}. ${c.contact} emailed this morning.`,
  ],
  goodwill: [
    (c) =>
      `${c.account} has had a rough onboarding — ${c.contact} asked if we can refund ${usd(c.value)} as a goodwill gesture. Charge was ${c.days} days ago.`,
    (c) =>
      `Goodwill ask: ${c.contact} at ${c.account} would like ${usd(c.value)} back after the migration delays. ${c.days} days since the invoice.`,
  ],
  competitive: [
    (c, r) =>
      `${c.contact} at ${c.account} has a quote about ${r.int(15, 35)}% under us. Can we do ${c.value}% off list for the renewal?`,
    (c) => `${c.account} is shopping us against a competitor. ${c.contact} needs ${c.value}% off to stay.`,
  ],
  multi_year: [
    (c, r) =>
      `${c.account} will sign a ${r.int(2, 3)}-year renewal if we give ${c.value}% off list. ${c.contact} is ready to sign this week.`,
    (c) => `Multi-year on ${c.account}: ${c.contact} asks ${c.value}% off for a three-year prepay.`,
  ],
  expansion: [
    (c, r) =>
      `${c.account} is adding ${r.int(30, 200)} seats; ${c.contact} is asking ${c.value}% off the whole contract.`,
  ],
  nonprofit: [
    (c) => `${c.account} just moved under a nonprofit foundation. ${c.contact} asked for ${c.value}% off.`,
  ],
  procurement_cycle: [
    (c) =>
      `${c.account} procurement only pays on Net-${c.value}. ${c.contact} says it's company-wide policy.`,
    (c) => `${c.contact} at ${c.account}: their AP runs Net-${c.value} for every vendor. Can we accept?`,
  ],
  public_sector: [
    (c) =>
      `${c.account} is public sector — statutory payment terms are Net-${c.value}. ${c.contact} sent the regulation.`,
  ],
  cash_flow: [
    (c) =>
      `${c.contact} at ${c.account} asked for Net-${c.value} this year because of cash flow; they've paid on time for two years.`,
  ],
};

export function requestText(reason: string, ctx: Ctx, rng: Rng): string {
  const t = REQ[reason] ?? REQ.outage!;
  return rng.pick(t)(ctx, rng);
}

export function approvalText(policy: PolicyId, value: number, citeNote: string | null, rng: Rng): string {
  const v = fmtValue(policy, value);
  const base = rng.pick([`Approved, ${v}.`, `OK — go ahead with ${v}.`, `Fine by me, ${v}.`, `Yes. ${v}.`]);
  return citeNote ? `${base} ${citeNote}` : base;
}

export function counterText(policy: PolicyId, asked: number, granted: number): string {
  return `Not ${fmtValue(policy, asked)}. We can do ${fmtValue(policy, granted)}.`;
}

export function denialText(clauseNote: string): string {
  return `No. ${clauseNote}`;
}

export function executionText(policy: PolicyId, value: number, rng: Rng): string {
  if (policy === 'refunds') return `Done — credit memo CM-${rng.int(10000, 99999)} issued for ${usd(value)}.`;
  if (policy === 'discounts') return `Quote Q-${rng.int(1000, 9999)} updated to ${value}% off list and sent.`;
  return `Terms on the account changed to Net-${value}; next invoice will reflect it.`;
}

export function ticketText(
  contact: { name: string; title: string; email: string; phone: string },
  account: string,
  body: string,
): string {
  return `${body}\n\nBest,\n${contact.name}\n${contact.title}, ${account}\n${contact.email} · ${contact.phone}`;
}
