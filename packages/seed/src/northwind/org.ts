import { FOREVER } from '@stare/core';
import { Rng } from '../rng.ts';
import type {
  AccountRow, AgentRow, ClauseRow, ContactRow, DelegationRow, GrantRow, HoldsRow, IncidentRow, MemberRow, OwnsRow,
  PersonRow, PolicyRow, ReportsRow, RoleRow, TeamRow, Tier, VersionRow,
} from '../model.ts';

/** Noon UTC on a calendar day. */
export const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12);
export const ANCHOR = D(2026, 10, 15);
const START = D(2024, 1, 1);

export const teams: TeamRow[] = [
  { id: 't-exec', name: 'Executive' },
  { id: 't-support', name: 'Customer Support' },
  { id: 't-cs', name: 'Customer Success' },
  { id: 't-renewals', name: 'Sales & Renewals' },
  { id: 't-finance', name: 'Finance' },
  { id: 't-legal', name: 'Legal' },
  { id: 't-eng', name: 'Engineering' },
  { id: 't-product', name: 'Product' },
];

type P = [id: string, name: string, title: string, team: string, joinedAt?: number, leftAt?: number];
const P_ROWS: P[] = [
  ['p-maya', 'Maya Okafor', 'Chief Executive Officer', 't-exec'],
  ['p-daniel', 'Daniel Brandt', 'Chief Financial Officer', 't-exec'],
  ['p-victor', 'Victor Hale', 'VP Customer Success', 't-cs', START, D(2026, 8, 29)],
  ['p-priya', 'Priya Raman', 'VP Customer Success', 't-cs', D(2026, 9, 1)],
  ['p-dana', 'Dana Whitfield', 'VP Sales', 't-renewals'],
  ['p-leah', 'Leah Morgan', 'General Counsel', 't-legal'],
  ['p-tomas', 'Tomás Ibarra', 'Controller', 't-finance'],
  ['p-ana', 'Ana Ruiz', 'Head of Support', 't-support'],
  ['p-kofi', 'Kofi Mensah', 'Support Lead', 't-support'],
  ['p-sofia', 'Sofia Marchetti', 'Support Lead', 't-support'],
  ['p-jordan', 'Jordan Pike', 'Support Specialist', 't-support'],
  ['p-lina', 'Lina Haddad', 'Support Specialist', 't-support'],
  ['p-tom', 'Tom Becker', 'Support Specialist', 't-support'],
  ['p-yuki', 'Yuki Tanaka', 'Support Specialist', 't-support'],
  ['p-omar', 'Omar Farouk', 'Support Specialist', 't-support'],
  ['p-ines', 'Inês Duarte', 'Support Specialist', 't-support', D(2025, 9, 1)],
  ['p-marcus', 'Marcus Chen', 'Renewals Director', 't-renewals'],
  ['p-rachel', 'Rachel Novak', 'Renewals Manager', 't-renewals'],
  ['p-ethan', 'Ethan Brooks', 'Account Manager', 't-renewals'],
  ['p-hana', 'Hana Kowalski', 'Account Executive', 't-renewals'],
  ['p-luis', 'Luis Ortega', 'Account Executive', 't-renewals'],
  ['p-noah', 'Noah Fischer', 'Account Executive', 't-renewals'],
  ['p-amara', 'Amara Nwosu', 'Account Manager', 't-renewals'],
  ['p-felix', 'Felix Wagner', 'Account Executive', 't-renewals'],
  ['p-zoe', 'Zoe Laurent', 'Account Manager', 't-renewals'],
  ['p-ravi', 'Ravi Iyer', 'Account Executive', 't-renewals', D(2025, 4, 1)],
  ['p-sasha', 'Sasha Petrov', 'Sales Operations', 't-renewals'],
  ['p-grace', 'Grace Kim', 'AR Manager', 't-finance'],
  ['p-ben', 'Ben Adler', 'Billing Specialist', 't-finance'],
  ['p-mila', 'Mila Sorensen', 'Billing Specialist', 't-finance'],
  ['p-arjun', 'Arjun Mehta', 'FP&A Analyst', 't-finance'],
  ['p-claire', 'Claire Dubois', 'Commercial Counsel', 't-legal'],
  ['p-erik', 'Erik Lindahl', 'SRE Lead', 't-eng'],
  ['p-sean', "Sean O'Brien", 'Engineering Manager', 't-eng'],
  ['p-mei', 'Mei Takahashi', 'Staff Engineer', 't-eng'],
  ['p-kai', 'Kai Andersen', 'Site Reliability Engineer', 't-eng'],
  ['p-leo', 'Leo Romano', 'Billing Engineer', 't-eng'],
  ['p-nina', 'Nina Alvarez', 'Head of Product', 't-product'],
  ['p-olga', 'Olga Ivanova', 'Product Manager', 't-product'],
  ['p-hugo', 'Hugo Lefebvre', 'Customer Success Manager', 't-cs'],
  ['p-tara', 'Tara Quinn', 'Customer Success Manager', 't-cs'],
  ['p-wes', 'Wes Carter', 'Customer Success Manager', 't-cs', D(2025, 2, 3)],
];

const slug = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/ /g, '.');

export const people: PersonRow[] = P_ROWS.map(([id, name, title, team, joinedAt, leftAt]) => ({
  id,
  name,
  title,
  team,
  email: `${slug(name)}@northwind.example`,
  joinedAt: joinedAt ?? START,
  leftAt: leftAt ?? FOREVER,
}));

export const members: MemberRow[] = people.map((p) => ({ person: p.id, team: p.team, validFrom: p.joinedAt, validTo: p.leftAt }));

export const roles: RoleRow[] = [
  { id: 'r-support-specialist', name: 'Support Specialist' },
  { id: 'r-support-lead', name: 'Support Lead' },
  { id: 'r-head-support', name: 'Head of Support' },
  { id: 'r-vp-cs', name: 'VP Customer Success' },
  { id: 'r-account-exec', name: 'Account Executive' },
  { id: 'r-renewals-manager', name: 'Renewals Manager' },
  { id: 'r-renewals-director', name: 'Renewals Director' },
  { id: 'r-vp-sales', name: 'VP Sales' },
  { id: 'r-billing', name: 'Billing Specialist' },
  { id: 'r-ar-manager', name: 'AR Manager' },
  { id: 'r-controller', name: 'Controller' },
  { id: 'r-cfo', name: 'Chief Financial Officer' },
  { id: 'r-ceo', name: 'Chief Executive Officer' },
];

const iv = (validFrom = START, validTo = FOREVER) => ({ validFrom, validTo });

/** Approval authority: who may approve exceptions to which policy, up to what (USD / % / net days). */
export const grants: GrantRow[] = [
  { role: 'r-support-lead', policy: 'refunds', cap: 1000, ...iv() },
  { role: 'r-head-support', policy: 'refunds', cap: 2500, ...iv() },
  { role: 'r-vp-cs', policy: 'refunds', cap: 5000, ...iv() },
  { role: 'r-controller', policy: 'refunds', cap: 10000, ...iv() },
  { role: 'r-cfo', policy: 'refunds', cap: 20000, ...iv() },
  { role: 'r-renewals-manager', policy: 'discounts', cap: 15, ...iv(START, D(2026, 1, 1)) },
  { role: 'r-renewals-manager', policy: 'discounts', cap: 20, ...iv(D(2026, 1, 1)) },
  { role: 'r-renewals-director', policy: 'discounts', cap: 25, ...iv() },
  { role: 'r-vp-sales', policy: 'discounts', cap: 35, ...iv() },
  { role: 'r-cfo', policy: 'discounts', cap: 50, ...iv() },
  { role: 'r-ar-manager', policy: 'payment_terms', cap: 45, ...iv() },
  { role: 'r-controller', policy: 'payment_terms', cap: 60, ...iv() },
  { role: 'r-cfo', policy: 'payment_terms', cap: 90, ...iv() },
  { role: 'r-ceo', policy: 'refunds', cap: 50000, ...iv() },
  { role: 'r-ceo', policy: 'discounts', cap: 60, ...iv() },
  { role: 'r-ceo', policy: 'payment_terms', cap: 120, ...iv() },
];

const H = (person: string, role: string, validFrom = START, validTo = FOREVER): HoldsRow => ({ person, role, validFrom, validTo });
const personById = new Map(people.map((p) => [p.id, p]));
export const holds: HoldsRow[] = [
  H('p-maya', 'r-ceo'),
  H('p-daniel', 'r-cfo'),
  H('p-victor', 'r-vp-cs', START, D(2026, 8, 29)),
  H('p-priya', 'r-vp-cs', D(2026, 9, 1)),
  H('p-dana', 'r-vp-sales'),
  H('p-tomas', 'r-controller'),
  H('p-ana', 'r-support-lead', START, D(2025, 7, 1)),
  H('p-ana', 'r-head-support', D(2025, 7, 1)),
  H('p-kofi', 'r-support-lead'),
  H('p-sofia', 'r-support-specialist', START, D(2025, 9, 15)),
  H('p-sofia', 'r-support-lead', D(2025, 9, 15)),
  ...['p-jordan', 'p-lina', 'p-tom', 'p-yuki', 'p-omar', 'p-ines'].map((p) => H(p, 'r-support-specialist', personById.get(p)!.joinedAt)),
  H('p-marcus', 'r-renewals-director'),
  H('p-rachel', 'r-renewals-manager'),
  H('p-ethan', 'r-account-exec', START, D(2026, 1, 1)),
  H('p-ethan', 'r-renewals-manager', D(2026, 1, 1)),
  ...['p-hana', 'p-luis', 'p-noah', 'p-amara', 'p-felix', 'p-zoe', 'p-ravi'].map((p) => H(p, 'r-account-exec', personById.get(p)!.joinedAt)),
  H('p-grace', 'r-ar-manager'),
  H('p-ben', 'r-billing'),
  H('p-mila', 'r-billing'),
];

const R = (person: string, manager: string, validFrom = START, validTo = FOREVER): ReportsRow => ({ person, manager, validFrom, validTo });
export const reports: ReportsRow[] = [
  R('p-daniel', 'p-maya'),
  R('p-victor', 'p-maya', START, D(2026, 8, 29)),
  R('p-priya', 'p-maya', D(2026, 9, 1)),
  R('p-dana', 'p-maya'),
  R('p-leah', 'p-maya'),
  R('p-tomas', 'p-daniel'),
  R('p-grace', 'p-tomas'),
  R('p-ben', 'p-grace'),
  R('p-mila', 'p-grace'),
  R('p-arjun', 'p-daniel'),
  R('p-ana', 'p-victor', START, D(2026, 8, 29)),
  R('p-ana', 'p-priya', D(2026, 9, 1)),
  R('p-hugo', 'p-victor', START, D(2026, 8, 29)),
  R('p-hugo', 'p-priya', D(2026, 9, 1)),
  R('p-tara', 'p-victor', START, D(2026, 8, 29)),
  R('p-tara', 'p-priya', D(2026, 9, 1)),
  R('p-wes', 'p-victor', D(2025, 2, 3), D(2026, 8, 29)),
  R('p-wes', 'p-priya', D(2026, 9, 1)),
  R('p-kofi', 'p-ana'),
  R('p-sofia', 'p-ana'),
  ...['p-jordan', 'p-lina', 'p-tom'].map((p) => R(p, 'p-kofi', personById.get(p)!.joinedAt)),
  ...['p-yuki', 'p-omar', 'p-ines'].map((p) => R(p, 'p-sofia', personById.get(p)!.joinedAt)),
  R('p-marcus', 'p-dana'),
  R('p-rachel', 'p-marcus'),
  R('p-ethan', 'p-marcus'),
  R('p-amara', 'p-rachel'),
  R('p-zoe', 'p-rachel'),
  ...['p-hana', 'p-luis', 'p-noah', 'p-felix', 'p-ravi', 'p-sasha'].map((p) => R(p, 'p-dana', personById.get(p)!.joinedAt)),
  R('p-claire', 'p-leah'),
  R('p-sean', 'p-maya'),
  R('p-erik', 'p-sean'),
  R('p-mei', 'p-sean'),
  R('p-kai', 'p-erik'),
  R('p-leo', 'p-sean'),
  R('p-nina', 'p-maya'),
  R('p-olga', 'p-nina'),
];

export const AGENTS_LIVE = D(2026, 4, 1);
export const agents: AgentRow[] = [
  { id: 'a-support', name: 'Support agent', kind: 'support', policyId: 'refunds', deployedAt: AGENTS_LIVE },
  { id: 'a-renewals', name: 'Renewals agent', kind: 'renewals', policyId: 'discounts', deployedAt: AGENTS_LIVE },
  { id: 'a-billing', name: 'Billing agent', kind: 'billing', policyId: 'payment_terms', deployedAt: AGENTS_LIVE },
];

export const delegations: DelegationRow[] = [
  { person: 'p-ana', agent: 'a-support', policyId: 'refunds', cap: 1000, validFrom: AGENTS_LIVE, validTo: FOREVER },
  { person: 'p-victor', agent: 'a-support', policyId: 'refunds', cap: 2500, validFrom: AGENTS_LIVE, validTo: D(2026, 8, 29) },
  { person: 'p-priya', agent: 'a-support', policyId: 'refunds', cap: 2000, validFrom: D(2026, 9, 2), validTo: FOREVER },
  { person: 'p-marcus', agent: 'a-renewals', policyId: 'discounts', cap: 20, validFrom: AGENTS_LIVE, validTo: FOREVER },
  { person: 'p-grace', agent: 'a-billing', policyId: 'payment_terms', cap: 45, validFrom: AGENTS_LIVE, validTo: FOREVER },
];

// ------------------------------------------------------------------ policies

export const policies: PolicyRow[] = [
  { id: 'refunds', name: 'Refund Policy', unit: 'usd', owner: 'p-daniel' },
  { id: 'discounts', name: 'Discount Policy', unit: 'pct', owner: 'p-dana' },
  { id: 'payment_terms', name: 'Payment Terms Policy', unit: 'days', owner: 'p-daniel' },
];

type C = [key: string, kind: 'default' | 'limit', text: string, field: string, op: string, value: unknown];
const vers: Array<[VersionRow, C[]]> = [
  [
    { id: 'refunds-v1', policyId: 'refunds', version: 1, effectiveFrom: START, effectiveTo: D(2025, 7, 1), text: 'Refund Policy v1' },
    [
      ['§4.1', 'default', 'Refunds may be issued within 30 days of the charge.', 'days', 'lte', 30],
      ['§4.2', 'default', 'Support may refund up to $500 without approval.', 'value', 'lte', 500],
      ['§4.5', 'limit', 'No refund later than 180 days after the charge.', 'days', 'lte', 180],
      ['§4.6', 'limit', 'No single refund above $10,000.', 'value', 'lte', 10000],
      ['§4.7', 'limit', 'No refunds to accounts in collections.', 'accountStatus', 'neq', 'collections'],
    ],
  ],
  [
    { id: 'refunds-v2', policyId: 'refunds', version: 2, effectiveFrom: D(2025, 7, 1), effectiveTo: D(2026, 9, 15), text: 'Refund Policy v2' },
    [
      ['§4.1', 'default', 'Refunds may be issued within 30 days of the charge.', 'days', 'lte', 30],
      ['§4.2', 'default', 'Support may refund up to $750 without approval.', 'value', 'lte', 750],
      ['§4.5', 'limit', 'No refund later than 120 days after the charge.', 'days', 'lte', 120],
      ['§4.6', 'limit', 'No single refund above $10,000.', 'value', 'lte', 10000],
      ['§4.7', 'limit', 'No refunds to accounts in collections.', 'accountStatus', 'neq', 'collections'],
    ],
  ],
  [
    { id: 'refunds-v3', policyId: 'refunds', version: 3, effectiveFrom: D(2026, 9, 15), effectiveTo: FOREVER, text: 'Refund Policy v3' },
    [
      ['§4.1', 'default', 'Refunds may be issued within 30 days of the charge.', 'days', 'lte', 30],
      ['§4.2', 'default', 'Support may refund up to $750 without approval.', 'value', 'lte', 750],
      ['§4.5', 'limit', 'No refund later than 60 days after the charge.', 'days', 'lte', 60],
      ['§4.6', 'limit', 'No single refund above $7,500.', 'value', 'lte', 7500],
      ['§4.7', 'limit', 'No refunds to accounts in collections.', 'accountStatus', 'neq', 'collections'],
      ['§4.8', 'limit', 'Goodwill is not a ground for a refund outside policy; offer service credit instead.', 'reason', 'nin', ['goodwill']],
    ],
  ],
  [
    { id: 'discounts-v1', policyId: 'discounts', version: 1, effectiveFrom: START, effectiveTo: D(2026, 3, 1), text: 'Discount Policy v1' },
    [
      ['§2.1', 'default', 'Account executives may discount up to 10% off list.', 'value', 'lte', 10],
      ['§2.4', 'limit', 'No discount above 50% off list.', 'value', 'lte', 50],
      ['§2.5', 'limit', 'No discounts for accounts in collections.', 'accountStatus', 'neq', 'collections'],
    ],
  ],
  [
    { id: 'discounts-v2', policyId: 'discounts', version: 2, effectiveFrom: D(2026, 3, 1), effectiveTo: FOREVER, text: 'Discount Policy v2' },
    [
      ['§2.1', 'default', 'Account executives may discount up to 10% off list.', 'value', 'lte', 10],
      ['§2.4', 'limit', 'No discount above 40% off list.', 'value', 'lte', 40],
      ['§2.5', 'limit', 'No discounts for accounts in collections.', 'accountStatus', 'neq', 'collections'],
    ],
  ],
  [
    { id: 'payment_terms-v1', policyId: 'payment_terms', version: 1, effectiveFrom: START, effectiveTo: D(2026, 6, 1), text: 'Payment Terms Policy v1' },
    [
      ['§3.1', 'default', 'Standard terms are Net-30.', 'value', 'lte', 30],
      ['§3.3', 'limit', 'No terms beyond Net-90.', 'value', 'lte', 90],
      ['§3.4', 'limit', 'No extended terms for accounts in collections.', 'accountStatus', 'neq', 'collections'],
    ],
  ],
  [
    { id: 'payment_terms-v2', policyId: 'payment_terms', version: 2, effectiveFrom: D(2026, 6, 1), effectiveTo: FOREVER, text: 'Payment Terms Policy v2' },
    [
      ['§3.1', 'default', 'Standard terms are Net-30.', 'value', 'lte', 30],
      ['§3.3', 'limit', 'No terms beyond Net-75.', 'value', 'lte', 75],
      ['§3.4', 'limit', 'No extended terms for accounts in collections.', 'accountStatus', 'neq', 'collections'],
    ],
  ],
];

export const versions: VersionRow[] = vers.map(([v, cs]) => ({
  ...v,
  text: `${v.text}\n${cs.map(([k, , t]) => `${k} ${t}`).join('\n')}`,
}));
export const clauses: ClauseRow[] = vers.flatMap(([v, cs]) =>
  cs.map(([key, kind, text, field, op, value]) => ({
    id: `${v.id}-${key.replace('§', 's')}`,
    versionId: v.id,
    key,
    kind,
    text,
    rule: { field, op, value },
  })),
);

// ------------------------------------------------------------------ accounts

const ACCOUNT_NAMES = [
  'Acme Logistics', 'Bluefin Analytics', 'Cobalt Health', 'Driftwood Studios', 'Ember Robotics', 'Fernway Travel',
  'Glasshouse Media', 'Halcyon Media', 'Ironleaf Capital', 'Juniper Schools', 'Kestrel Foods', 'Lumen Retail',
  'Meridian Freight', 'Northstar Robotics', 'Oakline Insurance', 'Pinecrest Clinics', 'Quarry Games', 'Redwood Legal',
  'Saltmarsh Energy', 'Tidewater Ports', 'Umber Coffee', 'Vantage Mobility', 'Willow Pharma', 'Yarrow Biotech',
  'Zephyr Air', 'Alder & Finch', 'Brightwater Utilities', 'Cinder Security', 'Dovetail Furniture', 'Evergreen Credit Union',
  'Foxglove Apparel', 'Gullwing Motors', 'Harbor City Transit', 'Indigo Print', 'Jetstream Courier', 'Keystone Builders',
  'Larkspur Hotels', 'Moraine Outdoor', 'Nimbus Weather', 'Orchid Telecom', 'Paloma Foods', 'Quill Publishing',
  'Riverbend Dairy', 'Sable Mining', 'Thistle Insurance', 'Upland Farms', 'Verity Audit', 'Westgate Mall',
  'Yellowfin Seafood', 'Zenith Fitness', 'Aurora Solar', 'Basalt Cloud', 'Copperline Rail', 'Dunmore Hospitals',
  'Elmstead University', 'Falcon Ridge Wines', 'Hollow Pine Games', 'Marigold Events', 'Silverline Payroll', 'Tamarack Outfitters',
];
const TIER_OF: Record<string, Tier> = {
  'Acme Logistics': 'growth', 'Bluefin Analytics': 'growth', 'Halcyon Media': 'growth', 'Kestrel Foods': 'growth',
  'Northstar Robotics': 'enterprise', 'Lumen Retail': 'growth', 'Willow Pharma': 'enterprise', 'Dunmore Hospitals': 'enterprise',
  'Elmstead University': 'enterprise', 'Harbor City Transit': 'enterprise', 'Fernway Travel': 'growth', 'Meridian Freight': 'growth',
  'Driftwood Studios': 'growth', 'Paloma Foods': 'enterprise', 'Quarry Games': 'growth', 'Glasshouse Media': 'growth',
};
const REGIONS = ['NA-East', 'NA-West', 'EU-West', 'EU-Central', 'APAC'];
const OWNERS = ['p-hana', 'p-luis', 'p-noah', 'p-amara', 'p-felix', 'p-zoe', 'p-ravi', 'p-ethan'];

const domainOf = (name: string) => `${name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '')}.example`;

export function buildAccounts(rng: Rng): { accounts: AccountRow[]; owns: OwnsRow[]; contacts: ContactRow[] } {
  const accounts: AccountRow[] = [];
  const owns: OwnsRow[] = [];
  const contacts: ContactRow[] = [];
  ACCOUNT_NAMES.forEach((name, i) => {
    const id = `acc-${domainOf(name).replace('.example', '')}`;
    const tier: Tier = TIER_OF[name] ?? (i % 5 === 0 ? 'enterprise' : i % 2 === 0 ? 'growth' : 'standard');
    const arr = tier === 'enterprise' ? rng.round(rng.int(180, 640) * 1000, 5000) : tier === 'growth' ? rng.round(rng.int(40, 170) * 1000, 1000) : rng.round(rng.int(8, 38) * 1000, 500);
    const status = name === 'Sable Mining' || name === 'Westgate Mall' ? 'collections' : 'active';
    accounts.push({
      id,
      name,
      domain: domainOf(name),
      tier,
      arr,
      region: name === 'Acme Logistics' ? 'EU-West' : rng.pick(REGIONS),
      status,
      renewalAt: D(2026, rng.int(11, 12), rng.int(1, 28)) + rng.int(0, 1) * 31_536_000_000,
    });
    const owner = name === 'Lumen Retail' ? 'p-ethan' : OWNERS[i % OWNERS.length]!;
    owns.push({ person: owner, account: id, validFrom: START, validTo: FOREVER });
    const n = tier === 'standard' ? 1 : 2;
    for (let k = 0; k < n; k++) {
      const fullName = name === 'Acme Logistics' && k === 0 ? 'Marta Lindqvist' : `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
      rng.int(0, 99); // keeps the generator's stream (and so the whole history) stable
      contacts.push({
        id: `c-${id.slice(4)}-${k + 1}`,
        name: fullName,
        email: `${slug(fullName)}@${domainOf(name)}`,
        phone: phoneFor(contacts.length),
        title: k === 0 ? rng.pick(['Head of Finance', 'Billing Manager', 'Procurement Lead', 'Controller', 'Operations Director']) : rng.pick(['IT Director', 'VP Operations', 'CTO', 'Head of Data']),
        account: id,
      });
    }
  });
  return { accounts, owns, contacts };
}

/** Unique fictional numbers: the reserved 555-0100..0199 range, then Ofcom's drama range. */
function phoneFor(i: number): string {
  return i < 100 ? `+1-555-01${String(i).padStart(2, '0')}` : `+44 20 7946 0${String(i).padStart(3, '0')}`;
}

const FIRST = ['Elena', 'Jonas', 'Priscilla', 'Mateo', 'Aisha', 'Henrik', 'Carmen', 'Dmitri', 'Fatima', 'Graham', 'Ingrid', 'Julian', 'Keiko', 'Lorenzo', 'Nadia', 'Oscar', 'Paula', 'Rafael', 'Sienna', 'Theo', 'Ursula', 'Viktor', 'Wendy', 'Yusuf', 'Zara', 'Bruno', 'Celeste', 'Diego', 'Freya', 'Gideon'];
const LAST = ['Andersson', 'Bianchi', 'Castillo', 'Dahl', 'Eriksen', 'Fontaine', 'Gallagher', 'Horvath', 'Ishikawa', 'Jovanovic', 'Kaur', 'Lindgren', 'Moreau', 'Nakamura', 'Oyelaran', 'Petrakis', 'Quintero', 'Rossi', 'Sato', 'Thorne', 'Ueda', 'Valdez', 'Whitaker', 'Yilmaz', 'Zielinski'];

// ------------------------------------------------------------------ incidents

export function buildIncidents(rng: Rng, accounts: AccountRow[]): IncidentRow[] {
  const ids = accounts.map((a) => a.id);
  const pickN = (n: number, must: string[] = []) => {
    const set = new Set(must);
    while (set.size < n) set.add(rng.pick(ids));
    return [...set];
  };
  return [
    { id: 'inc-2025-03-11', title: 'EU-West API outage', startedAt: D(2025, 3, 11), endedAt: D(2025, 3, 11) + 9 * 3600e3, severity: 'sev1', accounts: pickN(12, ['acc-kestrelfoods']) },
    { id: 'inc-2025-11-04', title: 'Ingest pipeline degradation', startedAt: D(2025, 11, 4), endedAt: D(2025, 11, 5) + 2 * 3600e3, severity: 'sev2', accounts: pickN(15, ['acc-bluefinanalytics', 'acc-glasshousemedia']) },
    { id: 'inc-2026-05-20', title: 'SSO login outage', startedAt: D(2026, 5, 20), endedAt: D(2026, 5, 20) + 5 * 3600e3, severity: 'sev1', accounts: pickN(18, ['acc-northstarrobotics', 'acc-meridianfreight', 'acc-driftwoodstudios']) },
    { id: 'inc-2026-09-04', title: 'EU-West ingest outage', startedAt: D(2026, 9, 4), endedAt: D(2026, 9, 4) + 11 * 3600e3, severity: 'sev1', accounts: pickN(14, ['acc-acmelogistics', 'acc-fernwaytravel']) },
    { id: 'inc-2026-10-02', title: 'Duplicate charges in the October billing run', startedAt: D(2026, 10, 2), endedAt: D(2026, 10, 3), severity: 'sev2', accounts: pickN(9) },
  ];
}
