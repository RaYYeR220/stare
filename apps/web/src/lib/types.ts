/** Response shapes of the Stare REST API (packages/server/src/rest.ts and views.ts). */

export type PolicyId = 'refunds' | 'discounts' | 'payment_terms';
export type Flag = 'green' | 'yellow' | 'red';
export type Outcome = 'approved' | 'counter' | 'escalated' | 'denied' | 'not_in_graph' | 'needs_info';
export type Basis = 'routine' | 'precedent' | 'rule' | 'human' | 'policy' | 'none';

export interface Session {
  token: string;
  sandbox: string;
  expiresAt: number;
}

export interface StandingReason {
  code: string;
  detail: string;
  nodeId: string;
}

export interface Standing {
  flag: Flag;
  reasons: StandingReason[];
  chain: string[];
}

export interface Intake {
  policyId: PolicyId | null;
  accountName: string | null;
  value: number | null;
  days: number | null;
  reason: string | null;
  claims: string[];
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

export interface TraceEntry {
  name: string;
  mode: 'ro' | 'rw';
  ms: number;
  rows: number;
  cypher: string;
  params: Record<string, unknown>;
}

export interface Verdict {
  outcome: Outcome;
  requested: number | null;
  value: number | null;
  basis: Basis;
  policyId: PolicyId | null;
  policyVersionId: string | null;
  account: { id: string; name: string; tier: string; status: string; ownerId: string | null; ownerName: string | null; score: number } | null;
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
  trace: TraceEntry[];
}

export interface Ablation {
  mode: 'structure-off';
  intake: Intake;
  outcome: 'approved' | 'counter' | 'no_precedent' | 'not_in_graph';
  value: number | null;
  precedent: { id: string; account: string; value: number; at: number; similarity: number; standing: Standing; covers: boolean } | null;
  ignored: string[];
  trace: { name: string; cypher: string }[];
}

export interface DecideResponse {
  verdict: Verdict;
  ablation: Ablation | null;
}

export interface Budget {
  id: string;
  policyId: PolicyId;
  unit: 'usd' | 'count';
  cap: number;
  remaining: number;
}

export interface AgentRow {
  id: string;
  name: string;
  kind: string;
  policyId: PolicyId;
  delegations: { person: string | null; personId: string | null; cap: number | null; policyId: string | null }[];
  lastEpisode: string | null;
  lastAt: number | null;
}

export interface Overview {
  decisions: number;
  green: number;
  yellow: number;
  red: number;
  open: number;
  ledgerSeq: number;
  ledgerHead: string;
  budgets: Budget[];
  agents: AgentRow[];
  model: string;
  offline: boolean;
  sandbox: string;
}

export interface Incoming {
  id: string;
  at: number;
  channel: string;
  from: string;
  text: string;
  agent: AgentId;
}

export type AgentId = 'a-support' | 'a-renewals' | 'a-billing';

export interface Person {
  id: string;
  name: string;
  title: string;
  active: boolean;
  roles: string[];
  authority: { cap: number; policy: PolicyId }[];
}

export interface PolicyClause {
  key: string;
  kind: 'default' | 'limit';
  text: string;
  /** JSON-encoded {field, op, value}. */
  rule: string;
}

export interface PolicyVersion {
  policyId: PolicyId;
  name: string;
  unit: 'usd' | 'pct' | 'days';
  versionId: string;
  version: number;
  from: number;
  to: number;
  current: boolean;
  clauses: PolicyClause[];
}

export interface Contact {
  id: string;
  name: string;
  title: string;
  account: string;
  mentions: number;
}

export interface InboxItem {
  id: string;
  at: number;
  why: string | null;
  pathIds: string[];
  caseId: string;
  policyId: PolicyId;
  value: number;
  reason: string;
  text: string;
  account: string;
  routedToId: string | null;
  routedTo: string | null;
}

export interface CaseRow {
  id: string;
  at: number;
  policyId: PolicyId;
  value: number;
  reason: string;
  text: string;
  status: string;
  filedBy: string;
  account: string;
  decisionId: string | null;
  outcome: Outcome | null;
  granted: number | null;
  basis: Basis | null;
  escalationId: string | null;
  escalationStatus: string | null;
  routedTo: string | null;
}

export interface DecisionRecord {
  id: string;
  outcome: Outcome;
  value: number | null;
  requested: number | null;
  basis: Basis;
  at: number;
  policyId: PolicyId;
  narrative: string | null;
  facts: string | null;
  madeById: string | null;
  madeBy: string | null;
  makerKind: 'Person' | 'Agent' | null;
  onAuthorityOf: string | null;
  policyVersion: string | null;
  account: string | null;
  tier: string | null;
  caseId: string | null;
  request: string | null;
  rule: string | null;
  ledgerSeq: number | null;
  ledgerHash: string | null;
  standing: Standing;
}

export interface ChainLink {
  from: string;
  to: string;
  account: string;
  value: number;
  at: number;
  madeBy: string;
  standing: Standing;
}

export interface Reversal {
  target: string;
  by: string;
  person: string | null;
  reason: string;
  at: number;
}

export interface SourceMessage {
  kind: string;
  id: string;
  text: string | null;
  at: number | null;
  author: string | null;
  channel: string | null;
  title: string | null;
  certificateHash: string | null;
}

export interface DecisionView {
  decision: DecisionRecord;
  chain: ChainLink[];
  reversals: Reversal[];
  sources: SourceMessage[];
}

export interface OverturnResult {
  ok: boolean;
  decisionId: string | null;
  ledgerSeq?: number;
  affected: string[];
  quarantined: string[];
}

export interface ResolveResult {
  ok: boolean;
  refusal: { code: string; detail: string } | null;
  decisionId: string | null;
  ledgerSeq: number | null;
  outcome: 'approved' | 'denied' | null;
  value: number | null;
  approver: { id: string; name: string; cap: number } | null;
  citations: string[];
  proposedRules: string[];
}

export interface RuleView {
  id: string;
  policyId: PolicyId;
  reason: string;
  tiers: string[];
  maxValue: number;
  text: string;
  status: 'ratified' | 'proposed' | 'quarantined' | string;
  ratifiedBy: string | null;
  ratifiedAt: number;
  basis: { id: string; account: string; at: number; value: number }[];
}

export interface RatifyResult {
  ok: boolean;
  ledgerSeq: number | null;
  refusal: string | null;
}

export interface ImpactReport {
  policyId: PolicyId;
  whatIfGraph: string;
  transitions: { from: string; to: string; count: number; ids: string[] }[];
  becameRed: number;
  becameYellow: number;
  rulesQuarantined: { id: string; text: string }[];
  autonomy: { before: number; after: number; sample: number };
  exposure: number;
  ms: number;
}

export interface AdoptResult {
  versionId: string | null;
  version: number | null;
  ledgerSeq: number | null;
  quarantined: string[];
}

export interface Check {
  id: 'C1' | 'C2' | 'C3' | 'C4';
  name: string;
  pass: boolean;
  detail: string;
}

export interface Certificate {
  erasureId: string;
  subjectCommitment: string;
  at: number;
  counts: {
    messagesErased: number;
    sourcesErased: number;
    factsDeleted: string[];
    factsRetained: { id: string; support: string[] }[];
    recordsRedacted: number;
    vectorsRewritten: number;
    decisionsRegrounded: number;
  };
  checks: Check[];
  ledger: { ok: boolean; length: number; head: string };
  verdict: 'ERASED' | 'REFUSED';
  certificateHash: string;
}

export interface ErasureResponse {
  certificate: Certificate;
  control: { checks: Check[]; verdict: 'ERASED' | 'REFUSED' } | null;
}

export interface ErasureRow {
  id: string;
  at: number;
  /** JSON-encoded certificate. */
  certificate: string;
}

export interface RaceReport {
  requests: number;
  uniqueCases: number;
  connections: number;
  outcomes: Record<string, number>;
  budgets: { id: string; unit: string; before: number; after: number; spent: number; neverNegative: boolean; conserved: boolean }[];
  invariants: { name: string; pass: boolean; detail: string }[];
  ledger: { ok: boolean; length: number };
  ms: number;
}

export interface IsolationProbe {
  ownGraph: { graph: string; ok: boolean; rows: number };
  attempts: { graph: string; command: string; error: string | null }[];
  aclLog: { reason: string; object: string; username: string; ageSeconds: number }[];
}

export interface LedgerVerdict {
  ok: boolean;
  length: number;
  head: string;
  brokenAt?: number;
  reason?: string;
  decisionsChecked?: number;
  mismatched?: { id: string; field: string; ledger: unknown; live: unknown }[];
  unrecorded?: string[];
  vanished?: string[];
}

export interface LedgerEntry {
  seq: number;
  kind: string;
  refId: string;
  hash: string;
  prev: string;
  at: number;
}

export interface LedgerResponse {
  verify: LedgerVerdict;
  tail: LedgerEntry[];
}

export interface LeadingCase {
  id: string;
  account: string;
  policyId: PolicyId;
  value: number;
  at: number;
  madeBy: string;
  score: number;
  followers: number;
  standing: Standing;
}

export interface Bottleneck {
  id: string;
  name: string;
  title: string;
  score: number;
  waiting: number;
}

export interface Cluster {
  communityId: number;
  size: number;
  policyId: PolicyId;
  reason: string;
  meanValue: number;
  flags: Partial<Record<Flag, number>>;
  ruleCandidate: boolean;
}

export interface MemoryItem {
  kind: 'fact' | 'episode';
  id: string;
  text: string;
  at: number;
  agent?: string;
  similarity?: number;
  sources?: string[];
  via: 'vector' | 'graph' | 'both';
}

export interface Step {
  kind: 'tool' | 'reply' | 'note';
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  structured?: unknown;
  text?: string;
  ms?: number;
}

export interface Transcript {
  agent: AgentId;
  request: string;
  steps: Step[];
  reply: string;
  ms: number;
}

export interface McpToken {
  url: string;
  token: string;
  principal: { kind: 'agent' | 'person'; id: string };
}

export interface Auditor {
  url: string;
  key: string;
  graph: string;
  user: string;
  allowed: string[];
}

export interface EvalArm {
  model: string;
  n: number;
  correct: number;
  accuracy: number;
  falseApprovals: number;
  overGrants: number;
  falseRefusals: number;
  leakedUsd: number;
  perClass: Record<string, { n: number; ok: number }>;
}

export interface EvalResults {
  sealedKeySha256: string;
  seal: string;
  ranAt: string;
  cases: number;
  arms: { stare: EvalArm; rag: EvalArm; llm: EvalArm };
}

export interface Health {
  ok: boolean;
  offline: boolean;
  model: string;
}
