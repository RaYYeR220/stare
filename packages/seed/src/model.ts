/** Plain rows a tenant is built from. `load.ts` turns them into nodes and edges. */

export interface Interval {
  validFrom: number;
  validTo: number;
}

export type PolicyId = 'refunds' | 'discounts' | 'payment_terms';
export type Tier = 'standard' | 'growth' | 'enterprise';

export interface PersonRow {
  id: string;
  name: string;
  email: string;
  title: string;
  team: string;
  joinedAt: number;
  leftAt: number;
}
export interface TeamRow { id: string; name: string }
export interface RoleRow { id: string; name: string }
export interface HoldsRow extends Interval { person: string; role: string }
export interface MemberRow extends Interval { person: string; team: string }
export interface ReportsRow extends Interval { person: string; manager: string }
export interface GrantRow extends Interval { role: string; policy: PolicyId; cap: number }
export interface AgentRow { id: string; name: string; kind: 'support' | 'renewals' | 'billing'; policyId: PolicyId; deployedAt: number }
export interface DelegationRow extends Interval { person: string; agent: string; policyId: PolicyId; cap: number }
export interface OwnsRow extends Interval { person: string; account: string }

export interface AccountRow {
  id: string;
  name: string;
  domain: string;
  tier: Tier;
  arr: number;
  region: string;
  status: 'active' | 'collections';
  renewalAt: number;
}
export interface ContactRow { id: string; name: string; email: string; phone: string; title: string; account: string }

export interface PolicyRow { id: PolicyId; name: string; unit: 'usd' | 'pct' | 'days'; owner: string }
export interface VersionRow {
  id: string;
  policyId: PolicyId;
  version: number;
  effectiveFrom: number;
  effectiveTo: number;
  text: string;
}
export interface ClauseRow {
  id: string;
  versionId: string;
  key: string;
  kind: 'default' | 'limit';
  text: string;
  rule: { field: string; op: string; value: unknown };
}

export interface IncidentRow {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number;
  severity: 'sev1' | 'sev2';
  accounts: string[];
}

export interface SourceRow { id: string; kind: 'slack' | 'email' | 'ticket' | 'doc'; title: string; channel: string; at: number }
export interface SpanRow { id: string; sourceId: string; text: string; at: number; author: string; mentions: string[] }
export interface FactRow { id: string; text: string; at: number; derivedFrom: string[]; about: string[] }

export interface CaseRow {
  id: string;
  key: string;
  policyId: PolicyId;
  accountId: string;
  contactId: string | null;
  value: number;
  days: number | null;
  reason: string;
  tier: Tier;
  accountStatus: 'active' | 'collections';
  text: string;
  at: number;
  filedBy: string;
  status: 'open' | 'escalated' | 'decided';
  incidentId: string | null;
}

export interface DecisionRow {
  id: string;
  caseId: string;
  outcome: 'approved' | 'counter' | 'denied';
  value: number;
  basis: 'routine' | 'precedent' | 'rule' | 'human';
  at: number;
  policyId: PolicyId;
  policyVersionId: string;
  accountId: string;
  madeBy: string;
  onAuthorityOf: string | null;
  facts: Record<string, unknown>;
  narrative: string;
  groundedIn: string[];
  cites: { id: string; similarity: number }[];
  citesRule: string | null;
  reason: string;
  /** Set on reversal decisions: the decision this one overturns. */
  overturns: { id: string; reason: string } | null;
}

export interface EscalationRow {
  id: string;
  caseId: string;
  routedTo: string;
  status: 'open' | 'approved' | 'rejected';
  at: number;
  pathIds: string[];
  resolvedBy: string | null;
}

export interface BudgetRow { id: string; policyId: PolicyId; period: string; unit: 'usd' | 'count'; cap: number; remaining: number; from: number; to: number }

export interface RuleRow {
  id: string;
  policyId: PolicyId;
  reasonCode: string;
  tiers: Tier[];
  maxValue: number;
  status: 'proposed' | 'ratified';
  createdAt: number;
  ratifiedAt: number | null;
  ratifiedBy: string | null;
  derivedFrom: string[];
  text: string;
}

export interface EpisodeRow { id: string; agentId: string; sessionId: string; at: number; summary: string; about: string[] }
export interface HandoffRow { id: string; from: string; to: string; caseId: string; note: string; at: number; status: 'open' | 'accepted' }

/** A request that has not arrived yet: the live case stream and the agents' day. */
export interface InboxItem {
  id: string;
  at: number;
  channel: string;
  from: string;
  text: string;
  expect?: string;
}

export interface TenantData {
  tenant: string;
  company: string;
  anchor: number;
  teams: TeamRow[];
  people: PersonRow[];
  roles: RoleRow[];
  members: MemberRow[];
  holds: HoldsRow[];
  reports: ReportsRow[];
  grants: GrantRow[];
  agents: AgentRow[];
  delegations: DelegationRow[];
  accounts: AccountRow[];
  contacts: ContactRow[];
  owns: OwnsRow[];
  policies: PolicyRow[];
  versions: VersionRow[];
  clauses: ClauseRow[];
  incidents: IncidentRow[];
  sources: SourceRow[];
  spans: SpanRow[];
  facts: FactRow[];
  cases: CaseRow[];
  decisions: DecisionRow[];
  escalations: EscalationRow[];
  budgets: BudgetRow[];
  rules: RuleRow[];
  episodes: EpisodeRow[];
  handoffs: HandoffRow[];
  inbox: InboxItem[];
  /** Named story nodes the demo, the tests and the eval refer to. */
  story: Record<string, string>;
}
