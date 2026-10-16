import type { QueryLogEntry } from '../db.ts';

export type PolicyId = 'refunds' | 'discounts' | 'payment_terms';
export const POLICY_IDS: PolicyId[] = ['refunds', 'discounts', 'payment_terms'];

/** What the language model is allowed to produce: fields, never a decision. */
export interface Intake {
  policyId: PolicyId | null;
  accountName: string | null;
  value: number | null;
  days: number | null;
  reason: string | null;
  /** Assertions in the request the engine must not rely on ("the VP already approved"). */
  claims: string[];
}

export interface Principal {
  kind: 'agent' | 'person';
  id: string;
}

export interface DecideRequest {
  principal: Principal;
  text?: string;
  /** Pre-parsed request (skips the language model). */
  intake?: Intake;
  /** Idempotency key: the same key always returns the same verdict. */
  key?: string;
  channel?: string;
  /** Evaluate only: nothing is written. */
  dryRun?: boolean;
}

export type Outcome = 'approved' | 'counter' | 'escalated' | 'denied' | 'not_in_graph' | 'needs_info';
export type Basis = 'routine' | 'precedent' | 'rule' | 'human' | 'policy' | 'none';
export type FlagColor = 'green' | 'yellow' | 'red';

export interface StandingReason {
  code: string;
  detail: string;
  nodeId: string;
}
export interface Standing {
  flag: FlagColor;
  reasons: StandingReason[];
  chain: string[];
}

export interface Candidate {
  id: string;
  account: string;
  value: number;
  at: number;
  reason: string;
  tier: string;
  days: number | null;
  madeBy: string;
  makerKind: 'Person' | 'Agent';
  standing: Standing;
  covers: boolean;
  partial: boolean;
  similarity: number | null;
  via: 'vector' | 'structure' | 'both';
}

export interface ClauseHit {
  clauseId: string;
  key: string;
  field: string | null;
  op: string | null;
  value: unknown;
  actual: unknown;
  text?: string;
}

export interface Route {
  personId: string;
  name: string;
  cap: number;
  pathIds: string[];
  pathNames: string[];
  hops: number;
}

export interface Verdict {
  outcome: Outcome;
  requested: number | null;
  value: number | null;
  basis: Basis;
  policyId: PolicyId | null;
  policyVersionId: string | null;
  account: {
    id: string;
    name: string;
    tier: string;
    status: string;
    ownerId: string | null;
    ownerName: string | null;
    score: number;
  } | null;
  intake: Intake;
  ignoredClaims: string[];
  limitViolations: ClauseHit[];
  defaultViolations: ClauseHit[];
  delegation: { personId: string; name: string; cap: number } | null;
  rule: { id: string; text: string; maxValue: number } | null;
  citations: Candidate[];
  candidates: Candidate[];
  route: Route | null;
  budget: { id: string; unit: string; cap: number; remaining: number; cost: number } | null;
  refusal: { code: string; detail: string } | null;
  caseId: string | null;
  decisionId: string | null;
  escalationId: string | null;
  ledgerSeq: number | null;
  explanation: string;
  explanationSource: 'model' | 'template';
  at: number;
  dryRun: boolean;
  trace: QueryLogEntry[];
}
