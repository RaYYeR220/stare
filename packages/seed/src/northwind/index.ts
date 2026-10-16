import type { TenantData } from '../model.ts';
import { Rng } from '../rng.ts';
import { World } from '../world.ts';
import { buildHistory } from './history.ts';
import { inbox } from './inbox.ts';
import {
  ANCHOR,
  agents,
  buildAccounts,
  buildIncidents,
  clauses,
  D,
  delegations,
  grants,
  holds,
  members,
  people,
  policies,
  reports,
  roles,
  teams,
  versions,
} from './org.ts';

export function buildNorthwind(): TenantData {
  const rng = new Rng(20261015);
  const { accounts, owns, contacts } = buildAccounts(rng);
  const incidents = buildIncidents(rng, accounts);
  const world = new World(holds, grants, owns, delegations, versions, clauses);
  const owners = new Map(owns.map((o) => [o.account, o.person]));
  const h = buildHistory({ rng, world, people, accounts, contacts, incidents, owners });

  const q4 = { from: D(2026, 10, 1), to: D(2027, 1, 1) };
  const spentRefunds = h.decisions
    .filter(
      (d) =>
        d.policyId === 'refunds' &&
        d.madeBy.startsWith('a-') &&
        d.basis !== 'routine' &&
        d.outcome !== 'denied' &&
        d.at >= q4.from,
    )
    .reduce((s, d) => s + d.value, 0);
  const countIn = (p: string) =>
    h.decisions.filter(
      (d) =>
        d.policyId === p &&
        d.madeBy.startsWith('a-') &&
        d.basis !== 'routine' &&
        d.outcome !== 'denied' &&
        d.at >= q4.from,
    ).length;

  return {
    tenant: 'northwind',
    company: 'Northwind Cloud',
    anchor: ANCHOR,
    teams,
    people,
    roles,
    members,
    holds,
    reports,
    grants,
    agents,
    delegations,
    accounts,
    contacts,
    owns,
    policies,
    versions,
    clauses,
    incidents,
    sources: h.sources,
    spans: h.spans,
    facts: h.facts,
    cases: h.cases,
    decisions: h.decisions,
    escalations: h.escalations,
    budgets: [
      {
        id: 'budget-refunds-2026q4',
        policyId: 'refunds',
        period: '2026-Q4',
        unit: 'usd',
        cap: 15000,
        remaining: 15000 - spentRefunds,
        ...q4,
      },
      {
        id: 'budget-discounts-2026q4',
        policyId: 'discounts',
        period: '2026-Q4',
        unit: 'count',
        cap: 12,
        remaining: 12 - countIn('discounts'),
        ...q4,
      },
      {
        id: 'budget-terms-2026q4',
        policyId: 'payment_terms',
        period: '2026-Q4',
        unit: 'count',
        cap: 10,
        remaining: 10 - countIn('payment_terms'),
        ...q4,
      },
    ],
    rules: h.rules,
    episodes: h.episodes,
    handoffs: h.handoffs,
    inbox,
    story: h.story,
  };
}
