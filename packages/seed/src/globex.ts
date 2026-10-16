import { DAY, FOREVER } from '@stare/core';
import type { CaseRow, ContactRow, DecisionRow, SourceRow, SpanRow, TenantData } from './model.ts';
import { ANCHOR, D } from './northwind/org.ts';

/**
 * Globex: a second, smaller tenant on the same FalkorDB instance. Its history deliberately contains
 * lookalike accounts and generous outage refunds — exactly what a shared index would leak into
 * Northwind's decisions. Per-tenant graphs behind ACL users make that impossible.
 */
export function buildGlobex(): TenantData {
  const START = D(2024, 6, 1);
  const people = [
    ['g-irene', 'Irene Vasquez', 'Chief Executive Officer'],
    ['g-paul', 'Paul Szabo', 'VP Customer Care'],
    ['g-hadley', 'Hadley Moss', 'Care Lead'],
    ['g-ken', 'Ken Watanabe', 'Account Executive'],
    ['g-lucia', 'Lucía Ferrer', 'Account Executive'],
    ['g-omid', 'Omid Rahimi', 'Finance Lead'],
  ].map(([id, name, title]) => ({
    id: id!,
    name: name!,
    title: title!,
    team: 'g-team',
    email: `${name!
      .toLowerCase()
      .replace(/[^a-z ]/g, '')
      .replace(' ', '.')}@globex.example`,
    joinedAt: START,
    leftAt: FOREVER,
  }));
  const accounts = [
    ['Acme Logistic GmbH', 'growth'],
    ['Bluefin Analytica', 'growth'],
    ['Kestrel Foods Europe', 'standard'],
    ['Northstar Robotic Systems', 'enterprise'],
    ['Halcyon Studios', 'growth'],
    ['Initech', 'standard'],
    ['Umbrella Freight', 'growth'],
    ['Vandelay Imports', 'standard'],
  ].map(([name, tier], i) => ({
    id: `gacc-${i + 1}`,
    name: name!,
    domain: `${name!.toLowerCase().replace(/[^a-z]/g, '')}.example`,
    tier: tier as 'growth',
    arr: 60000 + i * 9000,
    region: 'EU-Central',
    status: 'active' as const,
    renewalAt: D(2027, 2, 1),
  }));
  const contacts: ContactRow[] = accounts.map((a, i) => ({
    id: `gc-${i + 1}`,
    name: [
      'Jonas Weber',
      'Mira Kovac',
      'Ola Nordmann',
      'Ravi Kapoor',
      'Sanne de Vries',
      'Peter Gibbons',
      'Lena Fischer',
      'Art Vandelay',
    ][i]!,
    email: `contact${i + 1}@${a.domain}`,
    phone: `+1-555-02${String(i).padStart(2, '0')}`,
    title: 'Finance Manager',
    account: a.id,
  }));

  const cases: CaseRow[] = [];
  const decisions: DecisionRow[] = [];
  const sources: SourceRow[] = [];
  const spans: SpanRow[] = [];
  const outage = [
    [0, 2400, 46],
    [1, 2600, 50],
    [4, 2100, 44],
    [6, 2300, 48],
    [0, 2000, 41],
    [3, 4200, 30],
  ] as const;
  outage.forEach(([ai, value, days], i) => {
    const a = accounts[ai]!;
    const at = D(2025, 6, 1) + i * 37 * DAY;
    const id = `gcase-${i + 1}`;
    const text = `${a.name} asks for a $${value.toLocaleString('en-US')} refund after the Frankfurt outage; ${days} days since the charge.`;
    cases.push({
      id,
      key: `seed:${id}`,
      policyId: 'refunds',
      accountId: a.id,
      contactId: contacts[ai]!.id,
      value,
      days,
      reason: 'outage',
      tier: a.tier,
      accountStatus: 'active',
      text,
      at,
      filedBy: 'g-ken',
      status: 'decided',
      incidentId: null,
    });
    sources.push({
      id: `gsrc-${id}`,
      kind: 'slack',
      title: `${a.name} refund`,
      channel: '#care-escalations',
      at,
    });
    spans.push({ id: `gsrc-${id}-m1`, sourceId: `gsrc-${id}`, text, at, author: 'g-ken', mentions: [a.id] });
    spans.push({
      id: `gsrc-${id}-m2`,
      sourceId: `gsrc-${id}`,
      text: `Approved, $${value.toLocaleString('en-US')}.`,
      at: at + 3600e3,
      author: 'g-paul',
      mentions: [a.id],
    });
    decisions.push({
      id: `gdec-${i + 1}`,
      caseId: id,
      outcome: 'approved',
      value,
      basis: 'human',
      at: at + 3600e3,
      policyId: 'refunds',
      policyVersionId: 'refunds-v1',
      accountId: a.id,
      madeBy: 'g-paul',
      onAuthorityOf: null,
      facts: { policyId: 'refunds', value, days, reason: 'outage', tier: a.tier, accountStatus: 'active' },
      narrative: `Approved $${value.toLocaleString('en-US')} refund for ${a.name} (service outage, ${days} days after the charge). Decided by Paul Szabo.`,
      groundedIn: [`gsrc-${id}-m1`, `gsrc-${id}-m2`],
      cites: [],
      citesRule: null,
      reason: 'outage',
      overturns: null,
    });
  });

  return {
    tenant: 'globex',
    company: 'Globex',
    anchor: ANCHOR,
    teams: [{ id: 'g-team', name: 'Globex' }],
    people,
    roles: [
      { id: 'g-r-vp', name: 'VP Customer Care' },
      { id: 'g-r-ceo', name: 'CEO' },
    ],
    members: people.map((p) => ({ person: p.id, team: 'g-team', validFrom: START, validTo: FOREVER })),
    holds: [
      { person: 'g-paul', role: 'g-r-vp', validFrom: START, validTo: FOREVER },
      { person: 'g-irene', role: 'g-r-ceo', validFrom: START, validTo: FOREVER },
    ],
    reports: people
      .filter((p) => p.id !== 'g-irene')
      .map((p) => ({
        person: p.id,
        manager: p.id === 'g-paul' || p.id === 'g-omid' ? 'g-irene' : 'g-paul',
        validFrom: START,
        validTo: FOREVER,
      })),
    grants: [
      { role: 'g-r-vp', policy: 'refunds', cap: 6000, validFrom: START, validTo: FOREVER },
      { role: 'g-r-ceo', policy: 'refunds', cap: 50000, validFrom: START, validTo: FOREVER },
    ],
    agents: [
      {
        id: 'a-support',
        name: 'Care agent',
        kind: 'support',
        policyId: 'refunds',
        deployedAt: D(2026, 1, 1),
      },
    ],
    delegations: [
      {
        person: 'g-paul',
        agent: 'a-support',
        policyId: 'refunds',
        cap: 3000,
        validFrom: D(2026, 1, 1),
        validTo: FOREVER,
      },
    ],
    accounts,
    contacts,
    owns: accounts.map((a, i) => ({
      person: i % 2 ? 'g-lucia' : 'g-ken',
      account: a.id,
      validFrom: START,
      validTo: FOREVER,
    })),
    policies: [{ id: 'refunds', name: 'Globex Refund Policy', unit: 'usd', owner: 'g-omid' }],
    versions: [
      {
        id: 'refunds-v1',
        policyId: 'refunds',
        version: 1,
        effectiveFrom: START,
        effectiveTo: FOREVER,
        text: 'Globex Refund Policy v1',
      },
    ],
    clauses: [
      {
        id: 'g-refunds-v1-s1',
        versionId: 'refunds-v1',
        key: '§1',
        kind: 'default',
        text: 'Refunds within 45 days, up to $1,000.',
        rule: { field: 'value', op: 'lte', value: 1000 },
      },
      {
        id: 'g-refunds-v1-s2',
        versionId: 'refunds-v1',
        key: '§2',
        kind: 'limit',
        text: 'No refund later than 180 days.',
        rule: { field: 'days', op: 'lte', value: 180 },
      },
    ],
    incidents: [],
    sources,
    spans,
    facts: [],
    cases,
    decisions,
    escalations: [],
    budgets: [
      {
        id: 'g-budget-refunds-2026q4',
        policyId: 'refunds',
        period: '2026-Q4',
        unit: 'usd',
        cap: 20000,
        remaining: 20000,
        from: D(2026, 10, 1),
        to: D(2027, 1, 1),
      },
    ],
    rules: [],
    episodes: [],
    handoffs: [],
    inbox: [],
    story: { lookalikeAccount: 'gacc-1', generousOutage: 'gdec-5' },
  };
}
