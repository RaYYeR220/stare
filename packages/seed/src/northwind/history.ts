import { DAY } from '@stare/core';
import type {
  AccountRow,
  CaseRow,
  ContactRow,
  DecisionRow,
  EpisodeRow,
  EscalationRow,
  FactRow,
  HandoffRow,
  IncidentRow,
  PersonRow,
  PolicyId,
  RuleRow,
  SourceRow,
  SpanRow,
  Tier,
} from '../model.ts';
import type { Rng } from '../rng.ts';
import {
  approvalText,
  CHANNEL,
  counterText,
  denialText,
  executionText,
  fmtValue,
  REASON_LABEL,
  requestText,
  ticketText,
} from '../texts.ts';
import type { World } from '../world.ts';
import { AGENTS_LIVE, ANCHOR, D } from './org.ts';

const APPROVERS: Record<PolicyId, string[]> = {
  refunds: ['p-kofi', 'p-sofia', 'p-ana', 'p-victor', 'p-priya', 'p-tomas', 'p-daniel'],
  discounts: ['p-rachel', 'p-ethan', 'p-marcus', 'p-dana', 'p-daniel'],
  payment_terms: ['p-grace', 'p-tomas', 'p-daniel'],
};
const SPECIALISTS: Record<PolicyId, string[]> = {
  refunds: ['p-jordan', 'p-lina', 'p-tom', 'p-yuki', 'p-omar'],
  discounts: ['p-hana', 'p-luis', 'p-noah', 'p-felix', 'p-zoe'],
  payment_terms: ['p-ben', 'p-mila'],
};
const AGENT_FOR: Record<PolicyId, string> = {
  refunds: 'a-support',
  discounts: 'a-renewals',
  payment_terms: 'a-billing',
};
const REASONS: Record<PolicyId, string[]> = {
  refunds: [
    'outage',
    'outage',
    'billing_error',
    'billing_error',
    'churn_risk',
    'duplicate_charge',
    'goodwill',
  ],
  discounts: ['competitive', 'competitive', 'multi_year', 'churn_risk', 'expansion', 'nonprofit'],
  payment_terms: ['procurement_cycle', 'procurement_cycle', 'public_sector', 'cash_flow'],
};
const NOUN: Record<PolicyId, string> = {
  refunds: 'refund',
  discounts: 'discount',
  payment_terms: 'payment terms',
};

export interface HistoryInput {
  rng: Rng;
  world: World;
  people: PersonRow[];
  accounts: AccountRow[];
  contacts: ContactRow[];
  incidents: IncidentRow[];
  owners: Map<string, string>;
}

export interface History {
  cases: CaseRow[];
  decisions: DecisionRow[];
  escalations: EscalationRow[];
  sources: SourceRow[];
  spans: SpanRow[];
  facts: FactRow[];
  rules: RuleRow[];
  episodes: EpisodeRow[];
  handoffs: HandoffRow[];
  story: Record<string, string>;
}

export function buildHistory(input: HistoryInput): History {
  const { rng, world, accounts, contacts, incidents, owners } = input;
  const person = new Map(input.people.map((p) => [p.id, p]));
  const account = new Map(accounts.map((a) => [a.id, a]));
  const contactsOf = new Map<string, ContactRow[]>();
  for (const c of contacts) contactsOf.set(c.account, [...(contactsOf.get(c.account) ?? []), c]);
  const nameOf = (id: string) =>
    person.get(id)?.name ??
    (id === 'a-support' ? 'Support agent' : id === 'a-renewals' ? 'Renewals agent' : 'Billing agent');

  const h: History = {
    cases: [],
    decisions: [],
    escalations: [],
    sources: [],
    spans: [],
    facts: [],
    rules: [],
    episodes: [],
    handoffs: [],
    story: {},
  };
  const byId = new Map<string, DecisionRow>();
  const overturnsOf = new Map<string, DecisionRow[]>();
  let seq = 0;
  const nextId = (p: string) => `${p}-${String(++seq).padStart(4, '0')}`;

  const span = (sourceId: string, at: number, author: string, text: string, mentions: string[]) => {
    const s: SpanRow = {
      id: `${sourceId}-m${h.spans.filter((x) => x.sourceId === sourceId).length + 1}`,
      sourceId,
      text,
      at,
      author,
      mentions,
    };
    h.spans.push(s);
    return s;
  };

  interface CaseSpec {
    policy: PolicyId;
    accountId: string;
    value: number;
    days: number | null;
    reason: string;
    at: number;
    filedBy?: string;
    incidentId?: string | null;
    contactIdx?: number;
    ticket?: boolean;
  }

  function openCase(s: CaseSpec): {
    c: CaseRow;
    thread: SourceRow;
    request: SpanRow;
    ticketSpan: SpanRow | null;
    contact: ContactRow | null;
  } {
    const acc = account.get(s.accountId)!;
    const cs = contactsOf.get(acc.id) ?? [];
    const contact = cs[Math.min(s.contactIdx ?? 0, cs.length - 1)] ?? null;
    const inc = s.incidentId ? incidents.find((i) => i.id === s.incidentId) : undefined;
    const filedBy = s.filedBy ?? owners.get(acc.id)!;
    const id = nextId('case');
    const text = requestText(
      s.reason,
      {
        account: acc.name,
        contact: contact?.name ?? 'the customer',
        value: s.value,
        days: s.days,
        incident: inc?.title,
        hours: inc ? Math.round((inc.endedAt - inc.startedAt) / 3600e3) : undefined,
      },
      rng,
    );
    const c: CaseRow = {
      id,
      key: `seed:${id}`,
      policyId: s.policy,
      accountId: acc.id,
      contactId: contact?.id ?? null,
      value: s.value,
      days: s.days,
      reason: s.reason,
      tier: acc.tier,
      accountStatus: acc.status,
      text,
      at: s.at,
      filedBy,
      status: 'decided',
      incidentId: s.incidentId ?? null,
    };
    h.cases.push(c);
    const thread: SourceRow = {
      id: `src-${id}`,
      kind: 'slack',
      title: `${acc.name} — ${NOUN[s.policy]} request`,
      channel: CHANNEL[s.policy],
      at: s.at,
    };
    h.sources.push(thread);
    const request = span(thread.id, s.at, filedBy, text, [acc.id, ...(contact ? [contact.id] : []), filedBy]);
    let ticketSpan: SpanRow | null = null;
    if (contact && (s.ticket ?? rng.chance(0.7))) {
      const tk: SourceRow = {
        id: `tkt-${id}`,
        kind: 'ticket',
        title: `Ticket from ${acc.name}`,
        channel: 'support-inbox',
        at: s.at - 3600e3,
      };
      h.sources.push(tk);
      const body = rng.pick([
        `Hi team, following up on our call — we'd like to request a ${NOUN[s.policy]} adjustment (${fmtValue(s.policy, s.value)}).`,
        `Hello, as discussed with your team, we're asking for ${fmtValue(s.policy, s.value)} on our account. Details below.`,
        `Hi, please see our request regarding ${REASON_LABEL[s.reason]}. We're asking for ${fmtValue(s.policy, s.value)}.`,
      ]);
      ticketSpan = span(tk.id, tk.at, contact.id, ticketText(contact, acc.name, body), [acc.id, contact.id]);
    }
    return { c, thread, request, ticketSpan, contact };
  }

  interface DecideSpec {
    maker: string;
    onAuthorityOf?: string | null;
    outcome?: 'approved' | 'counter' | 'denied';
    value?: number;
    basis: DecisionRow['basis'];
    cites?: DecisionRow[];
    at?: number;
    note?: string;
    citesRule?: string | null;
    overturns?: { id: string; reason: string } | null;
  }

  function decide(o: ReturnType<typeof openCase>, s: DecideSpec): DecisionRow {
    const { c, thread, request, ticketSpan, contact } = o;
    const at = s.at ?? c.at + rng.int(2, 30) * 3600e3;
    const version = world.versionAt(c.policyId, at);
    const outcome = s.outcome ?? 'approved';
    const value = s.value ?? c.value;
    const acc = account.get(c.accountId)!;
    const cites = s.cites ?? [];
    const citeNote =
      s.note ??
      (cites.length ? `Same as ${cites.map((x) => account.get(x.accountId)!.name).join(' and ')}.` : null);
    const msg =
      outcome === 'denied'
        ? denialText(s.note ?? 'Outside what we can do.')
        : outcome === 'counter'
          ? counterText(c.policyId, c.value, value)
          : approvalText(c.policyId, value, citeNote, rng);
    const decisionSpan = span(
      thread.id,
      at,
      s.maker,
      s.maker.startsWith('a-') ? agentText(c, value, outcome, cites, s.onAuthorityOf ?? null) : msg,
      [acc.id, s.maker],
    );
    const grounded = [request.id, decisionSpan.id, ...(ticketSpan ? [ticketSpan.id] : [])];
    if (outcome !== 'denied') {
      const executor =
        c.policyId === 'payment_terms' || c.policyId === 'refunds'
          ? rng.pick(['p-ben', 'p-mila'])
          : owners.get(acc.id)!;
      span(thread.id, at + rng.int(1, 5) * 3600e3, executor, executionText(c.policyId, value, rng), [acc.id]);
    }
    const id = nextId('dec');
    const madeByName = nameOf(s.maker);
    const narrative =
      `${outcome === 'denied' ? 'Denied' : outcome === 'counter' ? 'Counter-offered' : 'Approved'} ${fmtValue(c.policyId, value)} ${NOUN[c.policyId]} for ${acc.name} ` +
      `(${REASON_LABEL[c.reason]}${c.days != null ? `, ${c.days} days after the charge` : ''})` +
      `${contact ? `, requested by ${contact.name}` : ''}. Decided by ${madeByName}` +
      `${s.onAuthorityOf ? ` on ${nameOf(s.onAuthorityOf)}'s delegation` : ''}` +
      `${cites.length ? `; follows ${cites.map((x) => `${account.get(x.accountId)!.name} (${new Date(x.at).toISOString().slice(0, 10)})`).join(', ')}` : ''}.`;
    const d: DecisionRow = {
      id,
      caseId: c.id,
      outcome,
      value,
      basis: s.basis,
      at,
      policyId: c.policyId,
      policyVersionId: version.id,
      accountId: acc.id,
      madeBy: s.maker,
      onAuthorityOf: s.onAuthorityOf ?? null,
      facts: {
        policyId: c.policyId,
        value,
        days: c.days,
        reason: c.reason,
        tier: c.tier,
        accountStatus: c.accountStatus,
      },
      narrative,
      groundedIn: grounded,
      cites: cites.map((x) => ({ id: x.id, similarity: Math.round((0.78 + rng.next() * 0.17) * 100) / 100 })),
      citesRule: s.citesRule ?? null,
      reason: c.reason,
      overturns: s.overturns ?? null,
    };
    h.decisions.push(d);
    byId.set(id, d);
    if (d.overturns) overturnsOf.set(d.overturns.id, [...(overturnsOf.get(d.overturns.id) ?? []), d]);
    return d;
  }

  function agentText(
    c: CaseRow,
    value: number,
    outcome: string,
    cites: DecisionRow[],
    onAuth: string | null,
  ) {
    const acc = account.get(c.accountId)!;
    const refs = cites
      .map((x) => `${account.get(x.accountId)!.name} (${new Date(x.at).toISOString().slice(0, 10)})`)
      .join(', ');
    if (outcome === 'approved' && cites.length)
      return `Approved ${fmtValue(c.policyId, value)} for ${acc.name} on precedent: ${refs} — good law as of today. Authority: ${nameOf(onAuth ?? '')}'s delegation.`;
    if (outcome === 'approved')
      return `Approved ${fmtValue(c.policyId, value)} for ${acc.name}: inside the routine envelope.`;
    return `${acc.name}: ${fmtValue(c.policyId, value)} — ${outcome}.`;
  }

  // ---- helpers for the generated background
  const greenCovering = (
    f: { policyId: PolicyId; reason: string; tier: Tier; days: number | null; value: number },
    t: number,
  ) => {
    const res: { full: DecisionRow[]; partial: DecisionRow[] } = { full: [], partial: [] };
    for (const p of h.decisions) {
      if (p.at >= t || p.overturns) continue;
      const cv = world.covers(p, f);
      if (!cv.covers && !cv.partial) continue;
      if (world.standing(p.id, t, byId, overturnsOf).flag !== 'green') continue;
      (cv.covers ? res.full : res.partial).push(p);
    }
    const recent = (a: DecisionRow, b: DecisionRow) => b.at - a.at;
    res.full.sort(recent);
    res.partial.sort((a, b) => b.value - a.value);
    return res;
  };

  const pickApprover = (policy: PolicyId, value: number, t: number, accountId: string): string | null => {
    const ok = APPROVERS[policy].filter((p) => {
      const pr = person.get(p)!;
      return (
        pr.joinedAt <= t &&
        t < pr.leftAt &&
        world.capAt(p, policy, t) >= value &&
        !world.ownsAt(p, accountId, t)
      );
    });
    if (!ok.length) return null;
    const minCap = Math.min(...ok.map((p) => world.capAt(p, policy, t)));
    return rng.pick(ok.filter((p) => world.capAt(p, policy, t) === minCap));
  };

  const acct = (name: string) => accounts.find((a) => a.name === name)!.id;

  // ================================================================ STORY
  // S1 — an unauthorized approval: a support specialist refunds $1,400 with no approval authority.
  const s1 = decide(
    openCase({
      policy: 'refunds',
      accountId: acct('Kestrel Foods'),
      value: 1400,
      days: 45,
      reason: 'outage',
      at: D(2025, 5, 14),
      filedBy: 'p-jordan',
      incidentId: 'inc-2025-03-11',
      ticket: true,
    }),
    { maker: 'p-jordan', basis: 'human', note: 'They were hit hard by the March outage, just do it.' },
  );
  h.story.unauthorized = s1.id;

  // S4 — an approval later overturned by the CFO.
  const s4 = decide(
    openCase({
      policy: 'refunds',
      accountId: acct('Halcyon Media'),
      value: 2200,
      days: 38,
      reason: 'churn_risk',
      at: D(2025, 10, 2),
      ticket: true,
    }),
    { maker: 'p-victor', basis: 'human' },
  );
  h.story.overturned = s4.id;

  // S2 — looks like a perfect precedent for an outage refund, but it rests on S1.
  const s2 = decide(
    openCase({
      policy: 'refunds',
      accountId: acct('Bluefin Analytics'),
      value: 1900,
      days: 45,
      reason: 'outage',
      at: D(2025, 12, 9),
      incidentId: 'inc-2025-11-04',
      ticket: true,
    }),
    { maker: 'p-ana', basis: 'human', cites: [s1], note: 'Same as Kestrel Foods in May.' },
  );
  h.story.restsOnUnauthorized = s2.id;

  // S5/S6 — churn-risk refunds that cite the overturned S4.
  const s5 = decide(
    openCase({
      policy: 'refunds',
      accountId: acct('Glasshouse Media'),
      value: 1600,
      days: 34,
      reason: 'churn_risk',
      at: D(2025, 11, 18),
    }),
    { maker: 'p-ana', basis: 'human', cites: [s4] },
  );
  const s6 = decide(
    openCase({
      policy: 'refunds',
      accountId: acct('Quarry Games'),
      value: 1500,
      days: 33,
      reason: 'churn_risk',
      at: D(2026, 1, 21),
    }),
    { maker: 'p-ana', basis: 'human', cites: [s5] },
  );
  h.story.citesOverturned = s5.id;
  h.story.citesOverturned2 = s6.id;

  // Overturn of S4 by the CFO after an audit.
  const rev = openCase({
    policy: 'refunds',
    accountId: acct('Halcyon Media'),
    value: 2200,
    days: null,
    reason: 'churn_risk',
    at: D(2026, 2, 17),
    filedBy: 'p-arjun',
    ticket: false,
  });
  rev.c.text =
    'Q1 audit: Halcyon Media churned two weeks after the October refund; the refund did not retain the account. Proposing to reverse it and claw back.';
  h.spans.find((x) => x.id === rev.request.id)!.text = rev.c.text;
  const reversal = decide(rev, {
    maker: 'p-daniel',
    basis: 'human',
    outcome: 'denied',
    at: D(2026, 2, 17) + 5 * 3600e3,
    note: 'Reversed. Refunds to stop churn need a signed renewal first.',
    overturns: { id: s4.id, reason: 'clawed back after the Q1 audit: the customer churned anyway' },
  });
  h.story.reversal = reversal.id;

  // S9 — a conflict of interest: the account manager approves a discount on his own account.
  const s9 = decide(
    openCase({
      policy: 'discounts',
      accountId: acct('Lumen Retail'),
      value: 18,
      days: null,
      reason: 'competitive',
      at: D(2026, 2, 10),
      filedBy: 'p-ethan',
    }),
    { maker: 'p-ethan', basis: 'human' },
  );
  h.story.conflict = s9.id;

  // S10 — three good-law outage refunds for growth accounts (the shape for a proposed standing rule).
  const r1 = decide(
    openCase({
      policy: 'refunds',
      accountId: acct('Meridian Freight'),
      value: 950,
      days: 33,
      reason: 'outage',
      at: D(2026, 5, 25),
      incidentId: 'inc-2026-05-20',
    }),
    { maker: 'p-ana', basis: 'human' },
  );
  const r2 = decide(
    openCase({
      policy: 'refunds',
      accountId: acct('Driftwood Studios'),
      value: 1100,
      days: 36,
      reason: 'outage',
      at: D(2026, 6, 2),
      incidentId: 'inc-2026-05-20',
    }),
    { maker: 'p-ana', basis: 'human', cites: [r1] },
  );
  // S3 — good law that covers outage refunds for growth accounts up to $1,200.
  const s3 = decide(
    openCase({
      policy: 'refunds',
      accountId: acct('Fernway Travel'),
      value: 1200,
      days: 49,
      reason: 'outage',
      at: D(2026, 7, 8),
      incidentId: 'inc-2026-05-20',
      ticket: true,
    }),
    { maker: 'p-ana', basis: 'human', cites: [r2] },
  );
  h.story.goodLawOutage = s3.id;
  h.rules.push({
    id: 'rule-refund-outage-growth',
    policyId: 'refunds',
    reasonCode: 'outage',
    tiers: ['growth', 'enterprise'],
    maxValue: 950,
    status: 'proposed',
    createdAt: s3.at + DAY,
    ratifiedAt: null,
    ratifiedBy: null,
    derivedFrom: [r1.id, r2.id, s3.id],
    text: 'Outage refunds for growth and enterprise accounts up to $950, within 60 days of the charge.',
  });

  // S7 — the departed VP: approved before leaving, still good law.
  const s7 = decide(
    openCase({
      policy: 'refunds',
      accountId: acct('Northstar Robotics'),
      value: 3000,
      days: 21,
      reason: 'outage',
      at: D(2026, 6, 3),
      incidentId: 'inc-2026-05-20',
      ticket: true,
    }),
    { maker: 'p-victor', basis: 'human' },
  );
  h.story.departedApprover = s7.id;
  // S8 — the support agent follows S7 on Victor's (then live) delegation.
  const s8o = openCase({
    policy: 'refunds',
    accountId: acct('Willow Pharma'),
    value: 2400,
    days: 18,
    reason: 'outage',
    at: D(2026, 7, 21),
    filedBy: 'p-tara',
  });
  const s8 = decide(s8o, { maker: 'a-support', onAuthorityOf: 'p-victor', basis: 'precedent', cites: [s7] });
  h.story.agentOnDepartedDelegation = s8.id;

  // S11 — the ratified rule: multi-year discounts for growth accounts up to 14%.
  const m1 = decide(
    openCase({
      policy: 'discounts',
      accountId: acct('Juniper Schools'),
      value: 14,
      days: null,
      reason: 'multi_year',
      at: D(2025, 8, 12),
    }),
    { maker: 'p-marcus', basis: 'human' },
  );
  const m2 = decide(
    openCase({
      policy: 'discounts',
      accountId: acct('Pinecrest Clinics'),
      value: 15,
      days: null,
      reason: 'multi_year',
      at: D(2025, 11, 6),
    }),
    { maker: 'p-marcus', basis: 'human', cites: [m1] },
  );
  const m3 = decide(
    openCase({
      policy: 'discounts',
      accountId: acct('Umber Coffee'),
      value: 15,
      days: null,
      reason: 'multi_year',
      at: D(2026, 2, 3),
    }),
    { maker: 'p-marcus', basis: 'human', cites: [m2] },
  );
  h.rules.push({
    id: 'rule-discount-multiyear-growth',
    policyId: 'discounts',
    reasonCode: 'multi_year',
    tiers: ['growth', 'enterprise'],
    maxValue: 14,
    status: 'ratified',
    createdAt: D(2026, 3, 10),
    ratifiedAt: D(2026, 3, 15),
    ratifiedBy: 'p-marcus',
    derivedFrom: [m1.id, m2.id, m3.id],
    text: 'Multi-year renewals for growth and enterprise accounts may be discounted up to 14% off list.',
  });
  h.story.ratifiedRule = 'rule-discount-multiyear-growth';
  h.story.proposedRule = 'rule-refund-outage-growth';

  // S13 — a 45% discount the CFO approved under v1; v2 caps discounts at 40%.
  const s13 = decide(
    openCase({
      policy: 'discounts',
      accountId: acct('Dunmore Hospitals'),
      value: 45,
      days: null,
      reason: 'competitive',
      at: D(2025, 11, 20),
    }),
    { maker: 'p-daniel', basis: 'human' },
  );
  h.story.supersededDiscount = s13.id;
  // S14 — Net-90 for a public-sector account under v1; v2 caps terms at Net-75.
  const s14 = decide(
    openCase({
      policy: 'payment_terms',
      accountId: acct('Elmstead University'),
      value: 90,
      days: null,
      reason: 'public_sector',
      at: D(2025, 9, 9),
    }),
    { maker: 'p-daniel', basis: 'human' },
  );
  h.story.supersededTerms = s14.id;

  // S12 — goodwill refunds under v2; v3 (Sept 15 2026) bans goodwill refunds outside policy.
  const goodwill: DecisionRow[] = [];
  const gwAccounts = [
    'Ironleaf Capital',
    'Redwood Legal',
    'Saltmarsh Energy',
    'Tidewater Ports',
    'Vantage Mobility',
    'Zephyr Air',
    'Cinder Security',
  ];
  gwAccounts.forEach((name, i) => {
    const at = D(2025, 8, 4) + i * 41 * DAY;
    const value = rng.round(rng.int(600, 1500), 50);
    const days = rng.int(32, 58);
    const o = openCase({ policy: 'refunds', accountId: acct(name), value, days, reason: 'goodwill', at });
    const cover = goodwill.filter(
      (p) => world.covers(p, { policyId: 'refunds', reason: 'goodwill', tier: o.c.tier, days, value }).covers,
    );
    const maker = pickApprover('refunds', value, at, o.c.accountId)!;
    goodwill.push(decide(o, { maker, basis: 'human', cites: cover.slice(0, 1) }));
  });
  h.story.goodwill = goodwill[0]!.id;

  // Acme's own history (the erasure subject appears here).
  const acme = acct('Acme Logistics');
  const acmeOld = decide(
    openCase({
      policy: 'refunds',
      accountId: acme,
      value: 320,
      days: 12,
      reason: 'billing_error',
      at: D(2025, 11, 26),
      contactIdx: 0,
      ticket: true,
    }),
    { maker: 'p-lina', basis: 'routine' },
  );
  h.story.acmeRoutine = acmeOld.id;
  const acmeTerms = decide(
    openCase({
      policy: 'payment_terms',
      accountId: acme,
      value: 45,
      days: null,
      reason: 'procurement_cycle',
      at: D(2026, 1, 14),
      contactIdx: 0,
      ticket: true,
    }),
    { maker: 'p-grace', basis: 'human' },
  );
  h.story.acmeTerms = acmeTerms.id;

  // ================================================================ BACKGROUND
  const months: number[] = [];
  // January 2025 to October 2026
  for (let i = 0; i < 22; i++) months.push(D(2025 + Math.floor(i / 12), (i % 12) + 1, 1));
  const active = accounts.filter((a) => a.status === 'active');
  const valueFor = (policy: PolicyId, routine: boolean, tier: Tier, reason: string, t: number) => {
    if (policy === 'refunds') {
      if (routine) return { value: rng.round(rng.int(80, 700), 10), days: rng.int(2, 30) };
      const limitDays = world.versionAt('refunds', t).id === 'refunds-v3' ? 60 : 110;
      const days = rng.int(31, limitDays);
      let value = rng.round(rng.int(800, tier === 'enterprise' ? 4800 : 3200), 50);
      if (reason === 'outage' && tier !== 'enterprise')
        value = Math.min(value, rng.round(rng.int(800, 1150), 50));
      return { value, days };
    }
    if (policy === 'discounts') {
      if (routine) return { value: rng.int(5, 10), days: null };
      const cap = world.versionAt('discounts', t).id === 'discounts-v2' ? 38 : 46;
      return { value: rng.int(11, cap), days: null };
    }
    if (routine) return { value: 30, days: null };
    const opts =
      world.versionAt('payment_terms', t).id === 'payment_terms-v2'
        ? [45, 45, 60, 75]
        : [45, 45, 60, 60, 75, 90];
    return { value: rng.pick(opts), days: null };
  };

  for (const m0 of months) {
    const n = m0 >= AGENTS_LIVE ? rng.int(8, 11) : rng.int(4, 6);
    for (let i = 0; i < n; i++) {
      const at = m0 + rng.int(0, 27) * DAY + rng.int(0, 8) * 3600e3;
      if (at >= ANCHOR - 2 * DAY) continue;
      const roll = rng.next();
      const policy: PolicyId = roll < 0.5 ? 'refunds' : roll < 0.8 ? 'discounts' : 'payment_terms';
      if (policy === 'payment_terms' && rng.chance(0.4)) continue;
      let acc = rng.pick(active);
      // Goodwill and churn-risk refunds only exist in the scripted story above.
      let reason = rng.pick(
        REASONS[policy].filter((r) => r !== 'goodwill' && !(policy === 'refunds' && r === 'churn_risk')),
      );
      const routine = policy !== 'payment_terms' && rng.chance(0.35);
      let { value, days } = valueFor(policy, routine, acc.tier, reason, at);
      if (at >= AGENTS_LIVE && !routine && rng.chance(0.6)) {
        // Agents mostly see requests that look like ones the company has granted before.
        const pool = h.decisions.filter(
          (p) =>
            p.policyId === policy &&
            p.basis !== 'routine' &&
            p.outcome === 'approved' &&
            !p.overturns &&
            p.at < at &&
            p.reason !== 'goodwill' &&
            p.reason !== 'churn_risk' &&
            world.standing(p.id, at, byId, overturnsOf).flag === 'green',
        );
        if (pool.length) {
          const p = rng.pick(pool);
          const pf = p.facts as { tier: Tier; days: number | null };
          const rank = (t: Tier) => (t === 'enterprise' ? 3 : t === 'growth' ? 2 : 1);
          acc = rng.pick(active.filter((a) => rank(a.tier) >= rank(pf.tier)));
          reason = p.reason;
          const step = policy === 'refunds' ? 50 : 1;
          value = Math.max(
            policy === 'refunds' ? 800 : policy === 'discounts' ? 11 : 45,
            rng.round(p.value * (0.6 + rng.next() * 0.4), step),
          );
          if (policy === 'payment_terms') value = p.value;
          days = pf.days == null ? null : rng.int(31, Math.max(31, pf.days));
        }
      }
      const incident =
        reason === 'outage' ? (incidents.filter((x) => x.startedAt < at).at(-1)?.id ?? null) : null;
      const agentEra = at >= AGENTS_LIVE;
      const agent = AGENT_FOR[policy];
      const o = openCase({
        policy,
        accountId: acc.id,
        value,
        days,
        reason,
        at,
        incidentId: incident,
        filedBy: routine ? rng.pick(SPECIALISTS[policy]) : undefined,
      });

      if (routine) {
        const del = agentEra ? world.delegationAt(agent, policy, at) : null;
        if (del && del.cap >= value && rng.chance(0.8))
          decide(o, { maker: agent, onAuthorityOf: del.person, basis: 'routine' });
        else decide(o, { maker: o.c.filedBy, basis: 'routine' });
        continue;
      }

      const f = { policyId: policy, reason, tier: acc.tier, days, value };
      const prec = greenCovering(f, at);
      const del = agentEra ? world.delegationAt(agent, policy, at) : null;
      if (del && del.cap >= value && prec.full.length && rng.chance(0.85)) {
        decide(o, {
          maker: agent,
          onAuthorityOf: del.person,
          basis: 'precedent',
          cites: prec.full.slice(0, rng.int(1, 2)),
        });
        continue;
      }
      const approver = pickApprover(policy, value, at, acc.id);
      if (!approver) continue;
      const deny = rng.chance(0.1);
      const cites = prec.full.length && rng.chance(0.7) ? prec.full.slice(0, 1) : [];
      if (agentEra) {
        // The agent escalated; a human with authority decided.
        h.escalations.push({
          id: `esc-${o.c.id}`,
          caseId: o.c.id,
          routedTo: approver,
          status: deny ? 'rejected' : 'approved',
          at: at + 3600e3,
          pathIds: [],
          resolvedBy: null,
        });
      }
      const d = decide(
        o,
        deny
          ? { maker: approver, basis: 'human', outcome: 'denied', note: 'Not this time.' }
          : { maker: approver, basis: 'human', cites },
      );
      if (agentEra) h.escalations.at(-1)!.resolvedBy = d.id;
    }
  }

  // ================================================================ OPEN ESCALATIONS (the approver inbox)
  const open = (
    name: string,
    policy: PolicyId,
    value: number,
    days: number | null,
    reason: string,
    routedTo: string,
    at: number,
  ) => {
    const o = openCase({ policy, accountId: acct(name), value, days, reason, at });
    o.c.status = 'escalated';
    o.c.filedBy = AGENT_FOR[policy];
    h.escalations.push({
      id: `esc-${o.c.id}`,
      caseId: o.c.id,
      routedTo,
      status: 'open',
      at: at + 3600e3,
      pathIds: [],
      resolvedBy: null,
    });
    return o.c.id;
  };
  h.story.openEscalationRefund = open(
    'Cobalt Health',
    'refunds',
    3400,
    44,
    'billing_error',
    'p-priya',
    ANCHOR - 30 * 3600e3,
  );
  h.story.openEscalationDiscount = open(
    'Ember Robotics',
    'discounts',
    30,
    null,
    'competitive',
    'p-dana',
    ANCHOR - 20 * 3600e3,
  );
  h.story.openEscalationTerms = open(
    'Tidewater Ports',
    'payment_terms',
    60,
    null,
    'procurement_cycle',
    'p-tomas',
    ANCHOR - 8 * 3600e3,
  );

  // ================================================================ FACTS (semantic memory)
  const billingThread: SourceRow = {
    id: 'src-billing-prefs',
    kind: 'slack',
    title: 'Invoice preferences roundup',
    channel: '#billing-ops',
    at: D(2026, 3, 2),
  };
  h.sources.push(billingThread);
  const acmePref = span(
    billingThread.id,
    billingThread.at,
    'p-mila',
    'Acme Logistics: refunds as credit notes, never card reversals — their AP reconciles credit notes only.',
    [acme],
  );
  const acmeTicket = h.spans.find(
    (s) =>
      s.sourceId.startsWith('tkt-') && s.mentions.includes(acme) && s.mentions.includes('c-acmelogistics-1'),
  )!;
  const marta = contacts.find((c) => c.id === 'c-acmelogistics-1')!;
  const acmeMail: SourceRow = {
    id: 'eml-acme-2026-02',
    kind: 'email',
    title: 'Re: invoice format',
    channel: 'email',
    at: D(2026, 2, 20),
  };
  h.sources.push(acmeMail);
  const acmeMailSpan = span(
    acmeMail.id,
    acmeMail.at,
    marta.id,
    `Please send any refunds as credit notes — our AP can't reconcile card reversals. I sign off every invoice above €5k myself.\n\n${marta.name}\n${marta.title}, Acme Logistics\n${marta.email} · ${marta.phone}`,
    [acme, marta.id],
  );
  h.facts.push({
    id: 'fact-acme-credit-notes',
    text: 'Acme Logistics wants refunds issued as credit notes, not card reversals.',
    at: acmeMail.at,
    derivedFrom: [acmePref.id, acmeMailSpan.id],
    about: [acme],
  });
  h.facts.push({
    id: 'fact-acme-signoff',
    text: `${marta.name} signs off every Acme Logistics invoice above €5k.`,
    at: acmeMail.at,
    derivedFrom: [acmeMailSpan.id, acmeTicket.id],
    about: [acme, marta.id],
  });
  h.story.erasureSubject = marta.id;
  h.story.factRetained = 'fact-acme-credit-notes';
  h.story.factErased = 'fact-acme-signoff';

  for (const acc of accounts) {
    const tickets = h.spans.filter((s) => s.sourceId.startsWith('tkt-') && s.mentions.includes(acc.id));
    const c = (contactsOf.get(acc.id) ?? [])[0];
    if (tickets.length && c && acc.id !== acme) {
      h.facts.push({
        id: `fact-${acc.id}-contact`,
        text: `${c.name} (${c.title}) is the main billing contact at ${acc.name}.`,
        at: tickets[0]!.at,
        derivedFrom: tickets.slice(0, 2).map((s) => s.id),
        about: [acc.id, c.id],
      });
    }
    const threads = h.spans.filter(
      (s) =>
        s.sourceId.startsWith('src-case') &&
        s.mentions.includes(acc.id) &&
        !s.mentions.some((m) => m.startsWith('c-')),
    );
    if (threads.length >= 2) {
      const pol = h.cases.find((x) => x.accountId === acc.id)!;
      h.facts.push({
        id: `fact-${acc.id}-history`,
        text: `${acc.name} has asked for ${NOUN[pol.policyId]} exceptions before; renewal is due ${new Date(acc.renewalAt).toISOString().slice(0, 10)}.`,
        at: threads[0]!.at,
        derivedFrom: threads.slice(0, 2).map((s) => s.id),
        about: [acc.id],
      });
    }
  }

  // ================================================================ EPISODES + HANDOFFS (agent memory)
  const agentDecisions = h.decisions.filter((d) => d.madeBy.startsWith('a-'));
  const sessions = new Map<string, DecisionRow[]>();
  for (const d of agentDecisions) {
    const key = `${d.madeBy}:${new Date(d.at).toISOString().slice(0, 10)}`;
    sessions.set(key, [...(sessions.get(key) ?? []), d]);
  }
  for (const [key, ds] of sessions) {
    const [agentId, day] = key.split(':') as [string, string];
    const parts = ds.map(
      (d) =>
        `${d.basis === 'routine' ? 'routine' : 'precedent'} ${fmtValue(d.policyId, d.value)} for ${account.get(d.accountId)!.name}`,
    );
    h.episodes.push({
      id: `ep-${agentId}-${day}`,
      agentId,
      sessionId: `${agentId}-${day}`,
      at: ds[0]!.at,
      summary: `Handled ${ds.length} request(s): ${parts.join('; ')}.`,
      about: [...new Set(ds.map((d) => d.accountId))],
    });
  }
  for (const e of h.escalations.filter((x) => x.status !== 'open' && x.at >= AGENTS_LIVE).slice(0, 25)) {
    const c = h.cases.find((x) => x.id === e.caseId)!;
    const agentId = AGENT_FOR[c.policyId];
    h.episodes.push({
      id: `ep-esc-${c.id}`,
      agentId,
      sessionId: `${agentId}-${new Date(e.at).toISOString().slice(0, 10)}`,
      at: e.at,
      summary: `Escalated ${fmtValue(c.policyId, c.value)} ${NOUN[c.policyId]} for ${account.get(c.accountId)!.name} to ${nameOf(e.routedTo)}: no good-law precedent covered it.`,
      about: [c.accountId],
    });
  }
  const handoffCases = h.cases.filter((c) => c.policyId === 'discounts' && c.at >= AGENTS_LIVE).slice(0, 4);
  for (const c of handoffCases) {
    h.handoffs.push({
      id: `ho-${c.id}`,
      from: 'a-support',
      to: 'a-renewals',
      caseId: c.id,
      note: `Customer asked support for a price concession on renewal; this is a discount, not a refund.`,
      at: c.at - 2 * 3600e3,
      status: 'accepted',
    });
  }

  return h;
}
