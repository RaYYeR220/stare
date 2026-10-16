import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { acceptedContent, type CallToolResult, inputRequired, McpServer } from '@modelcontextprotocol/server';
import {
  acceptHandoff,
  adoptPolicy,
  approvalBottlenecks,
  decide,
  draftFromCurrent,
  type EngineCtx,
  eraseSubject,
  exceptionClusters,
  fmtValue,
  handoff,
  handoffInbox,
  lastEpisode,
  leadingCases,
  listRules,
  POLICY_IDS,
  type PolicyId,
  type Principal,
  policyImpact,
  ratifyRule,
  recall,
  remember,
  renderSkill,
  resolveEscalation,
  type Verdict,
  verifyLedger,
} from '@stare/core';
import * as z from 'zod/v4';
import { cleanTrace } from '../rest.ts';
import type { Runtime } from '../runtime.ts';
import { decisionView, VIEW_QUERIES } from '../views.ts';
import { appHtml } from './apps.ts';

const ok = (summary: string, data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: summary }],
  structuredContent: data,
});
const refuse = (summary: string, data: Record<string, unknown> = {}): CallToolResult => ({
  content: [{ type: 'text', text: summary }],
  structuredContent: { refused: true, ...data },
  isError: false,
});

function verdictSummary(v: Verdict): string {
  const ask = fmtValue(v.policyId, v.requested);
  const head =
    v.outcome === 'approved'
      ? `APPROVED ${ask}`
      : v.outcome === 'counter'
        ? `COUNTER-OFFER ${fmtValue(v.policyId, v.value)} (asked ${ask})`
        : v.outcome === 'escalated'
          ? `ESCALATED to ${v.route?.name ?? 'an approver'}`
          : v.outcome === 'denied'
            ? 'DENIED'
            : v.outcome === 'not_in_graph'
              ? 'NOT IN THE GRAPH'
              : 'NEEDS INFORMATION';
  return `${head}${v.account ? ` — ${v.account.name}` : ''}. ${v.explanation}${v.decisionId ? ` [decision ${v.decisionId}, ledger #${v.ledgerSeq}]` : v.escalationId ? ` [escalation ${v.escalationId}]` : ''}`;
}

function compactVerdict(v: Verdict) {
  return {
    outcome: v.outcome,
    requested: v.requested,
    value: v.value,
    basis: v.basis,
    policyId: v.policyId,
    policyVersion: v.policyVersionId,
    account: v.account?.name ?? null,
    refusal: v.refusal,
    ignoredClaims: v.ignoredClaims,
    citations: v.citations.map((c) => ({
      id: c.id,
      account: c.account,
      value: c.value,
      at: new Date(c.at).toISOString().slice(0, 10),
      madeBy: c.madeBy,
      flag: c.standing.flag,
    })),
    notReliedOn: v.candidates
      .filter((c) => c.covers && c.standing.flag !== 'green')
      .slice(0, 3)
      .map((c) => ({
        id: c.id,
        account: c.account,
        flag: c.standing.flag,
        reasons: c.standing.reasons.map((r) => r.code),
        chain: c.standing.chain,
      })),
    delegation: v.delegation,
    route: v.route,
    rule: v.rule,
    budget: v.budget,
    decisionId: v.decisionId,
    escalationId: v.escalationId,
    ledgerSeq: v.ledgerSeq,
    explanation: v.explanation,
    explanationSource: v.explanationSource,
    cypher: cleanTrace(v.trace).map((t) => ({ name: t.name, ms: t.ms, rows: t.rows })),
  };
}

const confirmSchema = z.object({ confirm: z.boolean(), note: z.string().optional() });

/**
 * One MCP server per request, bound to the caller's desk (graph) and principal by the bearer token.
 * The model never writes Cypher and never sees database credentials: every tool is a fixed, named
 * operation, and the tenant comes from the token, not from any argument.
 */
export function buildMcpServer(rt: Runtime, ctx: EngineCtx, principal: Principal): McpServer {
  const server = new McpServer(
    { name: 'stare', version: '1.0.0' },
    {
      instructions:
        'Stare is a precedent desk: file business exceptions with file_exception; never promise a customer anything the desk did not approve.',
    },
  );
  const now = () => Date.now();
  const isPerson = principal.kind === 'person';

  // ------------------------------------------------------------ apps
  registerAppResource(
    server,
    'Decision trace',
    'ui://stare/trace',
    { description: 'Precedent chain, flags and authority behind a decision' },
    async () => ({
      contents: [{ uri: 'ui://stare/trace', mimeType: RESOURCE_MIME_TYPE, text: appHtml('trace') }],
    }),
  );
  registerAppResource(
    server,
    'Certificate of erasure',
    'ui://stare/certificate',
    { description: 'Proof that a data subject was erased' },
    async () => ({
      contents: [
        { uri: 'ui://stare/certificate', mimeType: RESOURCE_MIME_TYPE, text: appHtml('certificate') },
      ],
    }),
  );

  // ------------------------------------------------------------ decide
  registerAppTool(
    server,
    'file_exception',
    {
      title: 'File an exception request',
      description:
        'File a customer request for a refund, discount or payment terms. The desk decides it on precedent that is still good law, ' +
        'counter-offers, escalates to the right human, or refuses. Pass the request in plain words, as the customer or colleague wrote it.',
      inputSchema: z.object({ request: z.string().min(5).max(2000).describe('The request, verbatim') }),
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: 'ui://stare/trace' } },
    },
    async ({ request }) => {
      const v = await decide(ctx, { principal, text: request, channel: 'mcp' });
      return ok(verdictSummary(v), compactVerdict(v));
    },
  );

  server.registerTool(
    'find_precedent',
    {
      title: 'Find precedent',
      description:
        'Look up which past decisions cover a request and whether each is still good law, without deciding anything.',
      inputSchema: z.object({ request: z.string().min(5).max(2000) }),
      annotations: { readOnlyHint: true },
    },
    async ({ request }) => {
      const v = await decide(ctx, { principal, text: request, dryRun: true });
      const rows = v.candidates.map((c) => ({
        id: c.id,
        account: c.account,
        value: c.value,
        at: new Date(c.at).toISOString().slice(0, 10),
        covers: c.covers,
        flag: c.standing.flag,
        reasons: c.standing.reasons.map((r) => r.code),
        via: c.via,
      }));
      return ok(
        `${rows.length} candidate precedent(s); ${rows.filter((r) => r.flag === 'green' && r.covers).length} good law that covers it.`,
        { candidates: rows, wouldBe: v.outcome },
      );
    },
  );

  server.registerTool(
    'check_standing',
    {
      title: 'Check standing',
      description:
        'Is a decision still good law? Returns the flag, the reasons, and the chain to any precedent that is no longer good law.',
      inputSchema: z.object({ decisionId: z.string().regex(/^dec-[a-z0-9-]+$/) }),
      annotations: { readOnlyHint: true },
    },
    async ({ decisionId }) => {
      const view = await decisionView(ctx.db, decisionId, now());
      if (!view) return refuse(`No decision ${decisionId} in this desk.`);
      const s = view.decision.standing;
      return ok(
        `${decisionId}: ${s.flag.toUpperCase()}${s.reasons.length ? ` — ${s.reasons.map((r) => `${r.code}: ${r.detail}`).join('; ')}` : ''}`,
        { standing: s, chain: view.chain },
      );
    },
  );

  registerAppTool(
    server,
    'explain_decision',
    {
      title: 'Explain a decision',
      description:
        'The full trace of a decision: precedent chain with flags, authority, policy version, and the messages it rests on.',
      inputSchema: z.object({ decisionId: z.string().regex(/^dec-[a-z0-9-]+$/) }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: 'ui://stare/trace' } },
    },
    async ({ decisionId }) => {
      const view = await decisionView(ctx.db, decisionId, now());
      if (!view) return refuse(`No decision ${decisionId} in this desk.`);
      return ok(String(view.decision.narrative ?? ''), view as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    'trace_source',
    {
      title: 'Trace to source',
      description:
        'The original messages (Slack, email, tickets) a decision is grounded in, or the erasure record that replaced them.',
      inputSchema: z.object({ decisionId: z.string().regex(/^dec-[a-z0-9-]+$/) }),
      annotations: { readOnlyHint: true },
    },
    async ({ decisionId }) => {
      const view = await decisionView(ctx.db, decisionId, now());
      if (!view) return refuse(`No decision ${decisionId} in this desk.`);
      return ok(`${view.sources.length} source(s).`, { sources: view.sources });
    },
  );

  server.registerTool(
    'who_can_approve',
    {
      title: 'Who can approve',
      description:
        'People who hold authority over a policy right now, up to an amount, nearest first over the reporting graph.',
      inputSchema: z.object({ request: z.string().min(5).max(2000) }),
      annotations: { readOnlyHint: true },
    },
    async ({ request }) => {
      const v = await decide(ctx, {
        principal: { kind: 'person', id: 'p-maya' },
        text: request,
        dryRun: true,
      });
      return v.route
        ? ok(
            `${v.route.name} (up to ${fmtValue(v.policyId, v.route.cap)}), path: ${v.route.pathNames.join(' → ')}`,
            { route: v.route },
          )
        : refuse('Nobody holds that authority right now.', { route: null });
    },
  );

  // ------------------------------------------------------------ human rulings (multi-round-trip confirmation)
  server.registerTool(
    'approve_escalation',
    {
      title: 'Rule on an escalation',
      description:
        'Approve or reject an escalated request as yourself. Only people can rule; your authority, tenure and independence are checked at the moment of the ruling.',
      inputSchema: z.object({
        escalationId: z.string().regex(/^esc-[a-z0-9-]+$/),
        approve: z.boolean(),
        amount: z.number().positive().optional().describe('Grant less than asked (optional)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ escalationId, approve, amount }, extra) => {
      if (!isPerson) return refuse('Agents cannot rule on escalations. A person with authority must.');
      const [e] = await ctx.db.ro<{ account: string; value: number; policyId: PolicyId; routedTo: string }>(
        {
          name: 'mcp.escalation',
          mode: 'ro',
          doc: 'One open escalation.',
          cypher:
            "MATCH (e:Escalation {id:$id, status:'open'})-[:FOR]->(c:Case)-[:FOR]->(a:Account) OPTIONAL MATCH (e)-[:ROUTED_TO]->(p:Person) RETURN a.name AS account, c.value AS value, c.policyId AS policyId, p.name AS routedTo",
        },
        { id: escalationId },
      );
      if (!e) return refuse(`No open escalation ${escalationId}.`);
      const answer = acceptedContent(extra.mcpReq.inputResponses, 'confirm', confirmSchema);
      if (!answer) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `${approve ? 'Approve' : 'Reject'} ${fmtValue(e.policyId, amount ?? e.value)} for ${e.account}${e.routedTo ? ` (routed to ${e.routedTo})` : ''}? This is recorded in the ledger under your name.`,
              requestedSchema: {
                type: 'object',
                properties: {
                  confirm: { type: 'boolean', title: 'I confirm' },
                  note: { type: 'string', title: 'Note (optional)' },
                },
                required: ['confirm'],
              },
            }),
          },
        });
      }
      if (!answer.confirm) return refuse('Not confirmed; nothing recorded.');
      const r = await resolveEscalation(ctx, {
        escalationId,
        personId: principal.id,
        approve,
        value: amount,
        note: answer.note,
      });
      return r.ok
        ? ok(
            `Recorded: ${r.outcome} ${fmtValue(e.policyId, r.value)} — decision ${r.decisionId}, ledger #${r.ledgerSeq}.`,
            r as unknown as Record<string, unknown>,
          )
        : refuse(`Refused: ${r.refusal?.detail}`, r as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    'ratify_rule',
    {
      title: 'Ratify a standing rule',
      description:
        'Turn a proposed standing rule into one agents may use. Your authority must cover the rule ceiling, and its basis must still be good law.',
      inputSchema: z.object({ ruleId: z.string().regex(/^rule-[a-z0-9_-]+$/) }),
    },
    async ({ ruleId }, extra) => {
      if (!isPerson) return refuse('Only people ratify rules.');
      const answer = acceptedContent(extra.mcpReq.inputResponses, 'confirm', confirmSchema);
      if (!answer) {
        const rules = await listRules(ctx.db, now());
        const r = rules.find((x) => x.id === ruleId);
        if (!r) return refuse(`No rule ${ruleId}.`);
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Ratify "${r.text}"? Agents will apply it without escalation, up to ${fmtValue(r.policyId, r.maxValue)}, until any basis decision stops being good law.`,
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean', title: 'I ratify this rule' } },
                required: ['confirm'],
              },
            }),
          },
        });
      }
      if (!answer.confirm) return refuse('Not confirmed.');
      const res = await ratifyRule(ctx, ruleId, principal.id);
      return res.ok
        ? ok(`Ratified ${ruleId} (ledger #${res.ledgerSeq}).`, res)
        : refuse(`Refused: ${res.refusal}`, res);
    },
  );

  // ------------------------------------------------------------ graph algorithms
  server.registerTool(
    'leading_cases',
    {
      title: 'Leading cases',
      description:
        'The decisions the company leans on most (PageRank over citations), each with its live flag.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await leadingCases(ctx.db, now(), 10);
      return ok(
        rows
          .map(
            (r, i) =>
              `${i + 1}. ${r.account} ${new Date(r.at).toISOString().slice(0, 10)} — ${r.followers} follower(s), ${r.standing.flag}`,
          )
          .join('\n'),
        { cases: rows },
      );
    },
  );
  server.registerTool(
    'approval_bottlenecks',
    {
      title: 'Approval bottlenecks',
      description:
        'Who escalations funnel through (betweenness on the reporting graph) and what is waiting on them.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await approvalBottlenecks(ctx.db, now());
      return ok(
        rows
          .map((r) => `${r.name} (${r.title}): centrality ${r.score.toFixed(1)}, ${r.waiting} waiting`)
          .join('\n'),
        { people: rows },
      );
    },
  );
  server.registerTool(
    'exception_clusters',
    {
      title: 'Exception clusters',
      description:
        'Families of similar exceptions (label propagation), with their flag mix and whether they could become a standing rule.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await exceptionClusters(ctx.db, now());
      return ok(
        rows
          .map(
            (r) =>
              `${r.policyId}/${r.reason}: ${r.size} decisions, flags ${JSON.stringify(r.flags)}${r.ruleCandidate ? ', rule candidate' : ''}`,
          )
          .join('\n'),
        { clusters: rows },
      );
    },
  );

  // ------------------------------------------------------------ knowledge currency
  server.registerTool(
    'policy_impact',
    {
      title: 'Simulate a policy change',
      description:
        'Before changing a policy: which precedents stop being good law, which standing rules get quarantined, and how much autonomy the agents lose. Runs on a copy; nothing changes.',
      inputSchema: z.object({
        policyId: z.enum(POLICY_IDS as [PolicyId, ...PolicyId[]]),
        changes: z
          .array(
            z.object({
              key: z.string().describe('Clause key, e.g. §4.5'),
              value: z.union([z.number(), z.string()]),
            }),
          )
          .min(1)
          .max(6),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ policyId, changes }) => {
      const draft = await draftFromCurrent(ctx, policyId);
      draft.clauses = draft.clauses.map((c) => {
        const ch = changes.find((x) => x.key === c.key);
        return ch ? { ...c, rule: { ...c.rule, value: ch.value } } : c;
      });
      const r = await policyImpact(rt.admin, ctx, draft, { replay: 24 });
      return ok(
        `${r.becameRed} precedent(s) stop being good law, ${r.becameYellow} become Overruling Risk, ${r.rulesQuarantined.length} rule(s) quarantined; agent autonomy ${r.autonomy.before}% → ${r.autonomy.after}%.`,
        r as unknown as Record<string, unknown>,
      );
    },
  );

  server.registerTool(
    'adopt_policy',
    {
      title: 'Adopt a policy change',
      description: 'Adopt a new policy version now (ledgered). Precedent is re-flagged immediately.',
      inputSchema: z.object({
        policyId: z.enum(POLICY_IDS as [PolicyId, ...PolicyId[]]),
        changes: z
          .array(z.object({ key: z.string(), value: z.union([z.number(), z.string()]) }))
          .min(1)
          .max(6),
      }),
    },
    async ({ policyId, changes }, extra) => {
      if (!isPerson) return refuse('Only people adopt policy.');
      const answer = acceptedContent(extra.mcpReq.inputResponses, 'confirm', confirmSchema);
      if (!answer) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Adopt a new ${policyId} version with ${changes.map((c) => `${c.key} = ${c.value}`).join(', ')}?`,
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean', title: 'Adopt now' } },
                required: ['confirm'],
              },
            }),
          },
        });
      }
      if (!answer.confirm) return refuse('Not confirmed.');
      const draft = await draftFromCurrent(ctx, policyId);
      draft.clauses = draft.clauses.map((c) => {
        const ch = changes.find((x) => x.key === c.key);
        return ch ? { ...c, rule: { ...c.rule, value: ch.value } } : c;
      });
      const r = await adoptPolicy(ctx, draft);
      return ok(
        `Adopted ${r.versionId} (ledger #${r.ledgerSeq}); ${r.quarantined.length} rule(s) quarantined.`,
        r,
      );
    },
  );

  // ------------------------------------------------------------ forget with proof
  registerAppTool(
    server,
    'erase_subject',
    {
      title: 'Erase a data subject',
      description:
        'Erase a customer contact everywhere (messages, facts, decisions, vectors) while keeping the business record, and issue a certificate with four checks.',
      inputSchema: z.object({ contactId: z.string().regex(/^c-[a-z0-9-]+$/) }),
      annotations: { destructiveHint: true },
      _meta: { ui: { resourceUri: 'ui://stare/certificate' } },
    },
    async ({ contactId }, extra) => {
      if (!isPerson) return refuse('Only people can order an erasure.');
      const [subject] = await ctx.db.ro<{ name: string; account: string }>(
        {
          name: 'mcp.subject',
          mode: 'ro',
          doc: 'Subject to erase.',
          cypher:
            'MATCH (k:Contact {id:$id})-[:CONTACT_OF]->(a:Account) RETURN k.name AS name, a.name AS account',
        },
        { id: contactId },
      );
      if (!subject) return refuse(`No contact ${contactId}.`);
      const typed = acceptedContent(extra.mcpReq.inputResponses, 'confirm', z.object({ name: z.string() }));
      if (!typed) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Erasure cannot be undone. Type the full name of the contact at ${subject.account} to confirm.`,
              requestedSchema: {
                type: 'object',
                properties: { name: { type: 'string', title: 'Full name' } },
                required: ['name'],
              },
            }),
          },
        });
      }
      if (typed.name.trim().toLowerCase() !== subject.name.toLowerCase())
        return refuse('The name did not match; nothing erased.');
      const cert = await eraseSubject(ctx, contactId);
      return cert
        ? ok(
            `${cert.verdict}: ${cert.checks.map((c) => `${c.id} ${c.pass ? 'pass' : 'FAIL'}`).join(', ')} — certificate ${cert.certificateHash.slice(0, 12)}…`,
            cert as unknown as Record<string, unknown>,
          )
        : refuse('Nothing to erase.');
    },
  );

  // ------------------------------------------------------------ memory and coordination
  server.registerTool(
    'recall',
    {
      title: 'Recall',
      description:
        'What this desk remembers: past sessions of any agent and company facts, nearest to a question, expanded through an account.',
      inputSchema: z.object({ query: z.string().min(3).max(500), account: z.string().max(120).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, account }) => {
      const items = await recall(ctx.db, ctx.embedder, { query, account: account ?? null });
      return ok(
        items
          .slice(0, 8)
          .map((i) => `[${i.kind}${i.agent ? ` · ${i.agent}` : ''} · ${i.via}] ${i.text}`)
          .join('\n') || 'Nothing remembered.',
        { items: items.slice(0, 12) },
      );
    },
  );
  server.registerTool(
    'remember',
    {
      title: 'Remember',
      description:
        'Write an episode to this agent’s memory (persists across sessions, visible to the other agents).',
      inputSchema: z.object({
        summary: z.string().min(5).max(1000),
        about: z.array(z.string()).max(5).optional(),
      }),
    },
    async ({ summary, about }) => {
      if (isPerson) return refuse('Episodes are agent memory.');
      const prev = await lastEpisode(ctx.db, principal.id);
      const id = await remember(ctx.db, ctx.embedder, {
        agentId: principal.id,
        sessionId: `${principal.id}-${new Date().toISOString().slice(0, 10)}`,
        summary,
        about: about ?? [],
        now: now(),
      });
      return ok(`Remembered (${id})${prev ? `, after ${prev.id}` : ''}.`, { id, previous: prev?.id ?? null });
    },
  );
  server.registerTool(
    'handoff',
    {
      title: 'Hand off',
      description:
        'Pass a case to another agent with a note (e.g. a refund request that is really a discount).',
      inputSchema: z.object({
        to: z.enum(['a-support', 'a-renewals', 'a-billing']),
        note: z.string().min(5).max(500),
        caseId: z.string().optional(),
      }),
    },
    async ({ to, note, caseId }) => {
      if (isPerson) return refuse('Handoffs are between agents.');
      const id = await handoff(ctx.db, { from: principal.id, to, note, caseId: caseId ?? null, now: now() });
      return ok(`Handed off to ${to} (${id}).`, { id });
    },
  );
  server.registerTool(
    'my_handoffs',
    {
      title: 'My handoffs',
      description: 'Open handoffs waiting for this agent; accepting one marks it taken.',
      inputSchema: z.object({ accept: z.string().optional() }),
    },
    async ({ accept }) => {
      if (accept) await acceptHandoff(ctx.db, accept, principal.id, now());
      const items = await handoffInbox(ctx.db, principal.id);
      return ok(items.map((h) => `${h.id} from ${h.from}: ${h.note}`).join('\n') || 'No open handoffs.', {
        handoffs: items,
      });
    },
  );

  server.registerTool(
    'my_inbox',
    {
      title: 'My approvals',
      description: 'Escalations waiting for a ruling.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await ctx.db.ro<{
        id: string;
        account: string;
        value: number;
        policyId: PolicyId;
        routedTo: string;
        routedToId: string;
        why: string;
      }>(VIEW_QUERIES.inbox);
      const mine = isPerson ? rows.filter((r) => r.routedToId === principal.id) : rows;
      return ok(
        mine
          .map(
            (r) =>
              `${r.id}: ${fmtValue(r.policyId, r.value)} ${r.policyId} for ${r.account} → ${r.routedTo} (${r.why})`,
          )
          .join('\n') || 'Nothing waiting.',
        { escalations: mine },
      );
    },
  );

  server.registerTool(
    'verify_ledger',
    {
      title: 'Verify the ledger',
      description:
        'Recompute the whole hash chain and check every decision against what the ledger recorded.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const v = await verifyLedger(ctx.db, { deep: true });
      return ok(
        v.ok
          ? `Ledger verifies: ${v.length} entries, ${v.decisionsChecked} decisions match, head ${v.head.slice(0, 16)}…`
          : `LEDGER BROKEN: ${v.reason}`,
        v as unknown as Record<string, unknown>,
      );
    },
  );

  // ------------------------------------------------------------ resources
  server.registerResource(
    'standing-rules',
    'stare://skills/standing-rules/SKILL.md',
    {
      title: 'Standing rules (SKILL.md)',
      description: 'Ratified standing rules compiled into a skill any agent runtime can load.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: renderSkill('Northwind Cloud', await listRules(ctx.db, now()), now()),
        },
      ],
    }),
  );

  return server;
}
