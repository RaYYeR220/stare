'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Meter, Stamp } from '@/components/bits';
import { Glyph, Signal } from '@/components/Glyph';
import { useDesk } from '@/lib/desk';
import {
  AGENT_NAME,
  CODE_GLOSS,
  count,
  date,
  FLAG_NAME,
  money,
  OUTCOME_STAMP,
  POLICY_NAME,
  reason,
  term,
  value as fmt,
} from '@/lib/format';
import type { Ablation, Candidate, ClauseHit, Verdict } from '@/lib/types';
import { Appendix } from './Appendix';
import { ChainLine, CodeChip, type Known, useKnown } from './chain';

function actorName(actor: string, personName: (id: string) => string): string {
  return AGENT_NAME[actor] ?? personName(actor);
}

function granted(v: Verdict): string {
  const p = v.policyId;
  switch (v.outcome) {
    case 'approved':
      return `Granted ${fmt(p, v.value)}`;
    case 'counter':
      return `Offered ${fmt(p, v.value)} of ${fmt(p, v.requested)}`;
    case 'escalated':
      return v.route ? `Waiting on ${v.route.name}` : 'Waiting on a person';
    case 'needs_info':
      return 'Nothing granted until the request is complete';
    default:
      return 'Nothing granted';
  }
}

function clauseActual(c: ClauseHit, policyId: string | null): string {
  if (c.field === 'days') return `${c.actual} days`;
  if (c.field === 'value') return fmt(policyId, Number(c.actual));
  return String(c.actual);
}

function Citation({ c, policy }: { c: Candidate; policy: string | null }) {
  return (
    <li className="headnote">
      <Glyph signal={c.standing.flag} />
      <span className="cite strikeable">
        <Link href={`/desk/decision/${c.id}`}>
          <i>{c.account}</i>
        </Link>
        , {c.id} ({c.madeBy}, {term(c.at)}), {fmt(policy, c.value)} for {reason(c.reason)}, {c.tier} tier
      </span>
      <span className="cite-sub">
        {FLAG_NAME[c.standing.flag]}. Found by{' '}
        {c.via === 'both' ? 'vector search and the graph' : c.via === 'vector' ? 'vector search' : 'the graph'}
        {c.similarity != null ? `, similarity ${c.similarity.toFixed(2)}` : ''}.
      </span>
    </li>
  );
}

/** Commission for a verdict: who acted, under whose delegation, and who the authority graph routes to. */
function Commission({ v, actor }: { v: Verdict; actor: string }) {
  const { people, personName } = useDesk();
  const capOf = (pid: string) => people.find((p) => p.id === pid)?.authority.find((a) => a.policy === v.policyId)?.cap;
  const titleOf = (pid: string) => people.find((p) => p.id === pid)?.title;
  const steps: { name: string; role: string; end?: boolean }[] = [];
  const isAgent = actor.startsWith('a-');
  steps.push({
    name: actorName(actor, personName),
    role: isAgent
      ? v.delegation
        ? `acts under a delegation from ${v.delegation.name}, up to ${fmt(v.policyId, v.delegation.cap)}`
        : 'no delegation on file for this policy'
      : 'acting in person, on their own authority',
  });
  if (v.rule) steps.push({ name: 'Standing rule', role: `${v.rule.text} (${v.rule.id}, ceiling ${fmt(v.policyId, v.rule.maxValue)})` });
  if (v.route) {
    v.route.pathIds.forEach((pid, i) => {
      const cap = capOf(pid);
      const last = i === v.route!.pathIds.length - 1;
      steps.push({
        name: v.route!.pathNames[i] ?? personName(pid),
        role: `${titleOf(pid) ?? 'Northwind Cloud'}${last ? `, may approve ${fmt(v.policyId, v.route!.cap)}: routed here` : cap != null ? `, may approve ${fmt(v.policyId, cap)}, not enough` : ', no authority for this'}`,
        end: last,
      });
    });
  }
  return (
    <>
      <ol className="commission-list strikeable">
        {steps.map((s, i) => (
          <li key={`${s.name}-${i}`} data-end={s.end ? 'true' : undefined}>
            <span className="commission-name">{s.name}</span>
            <span className="commission-role">{s.role}</span>
          </li>
        ))}
      </ol>
      {v.budget ? (
        <div className="op-budget">
          <Meter
            label={`Autonomy budget (${v.budget.id.replace(/^budget-/, '')}), this request ${v.budget.unit === 'usd' ? money(v.budget.cost) : count(v.budget.cost)}`}
            remaining={v.budget.remaining}
            cap={v.budget.cap}
            format={v.budget.unit === 'usd' ? money : (n) => count(n)}
          />
        </div>
      ) : null}
    </>
  );
}

const ABLATION_STAMP: Record<Ablation['outcome'], { outcome: 'approved' | 'counter' | 'not_in_graph'; label: string }> = {
  approved: { outcome: 'approved', label: 'Approved' },
  counter: { outcome: 'counter', label: 'Counter-offer' },
  no_precedent: { outcome: 'not_in_graph', label: 'No precedent' },
  not_in_graph: { outcome: 'not_in_graph', label: 'Not in the graph' },
};

/** The structure-off sheet: the same request, decided by vector similarity alone. */
function Unbound({ a, v, known }: { a: Ablation; v: Verdict; known: Record<string, Known> }) {
  const p = a.precedent;
  const policy = a.intake.policyId;
  const stamp = ABLATION_STAMP[a.outcome];
  const holding =
    a.outcome === 'approved' && p
      ? `Grant ${fmt(policy, a.value)}, because ${p.account} was granted ${fmt(policy, p.value)}.`
      : a.outcome === 'counter' && p
        ? `Offer ${fmt(policy, a.value)}, the most ${p.account} was granted.`
        : a.outcome === 'no_precedent'
          ? 'Nothing similar was ever approved, so there is nothing to follow.'
          : 'The customer cannot be found, so there is nothing to follow.';
  const diverges = a.outcome !== v.outcome || (a.value ?? null) !== (v.value ?? null);
  return (
    <aside className="unbound" aria-label="Structure off: a vector-only agent on the same request">
      <p className="op-h">Structure off</p>
      <h3 className="unbound-title">What a vector-only agent would do</h3>
      <div className="unbound-section row" style={{ justifyContent: 'space-between' }}>
        <Stamp outcome={stamp.outcome} label={stamp.label} />
        {a.value != null ? <span className="muted">{fmt(policy, a.value)}</span> : null}
      </div>
      <div className="unbound-section">
        <p className="unbound-holding">{holding}</p>
      </div>
      {p ? (
        <div className="unbound-section stack" style={{ gap: 10 }}>
          <p className="op-h">It would follow</p>
          <p className="cite">
            <Link href={`/desk/decision/${p.id}`}>
              <i>{p.account}</i>
            </Link>
            , {p.id} ({term(p.at)}), {fmt(policy, p.value)}, similarity {p.similarity.toFixed(2)}.
            {p.covers ? '' : ' It does not cover these facts.'}
          </p>
          <p className="op-h" style={{ marginTop: 6 }}>
            That precedent today
          </p>
          <Signal signal={p.standing.flag}>
            {FLAG_NAME[p.standing.flag]}
            {p.standing.reasons[0] ? `: ${CODE_GLOSS[p.standing.reasons[0].code] ?? p.standing.reasons[0].detail}` : ''}
          </Signal>
          {p.standing.chain.length ? <ChainLine id={p.id} account={p.account} standing={p.standing} known={known} /> : null}
        </div>
      ) : null}
      <div className="unbound-section">
        <p className="op-h">It never checked</p>
        <ul>
          {a.ignored.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
      <div className="unbound-section">
        <p className="op-note" style={{ color: 'var(--ink-2)', marginTop: 0 }}>
          {diverges
            ? `The desk ruled ${OUTCOME_STAMP[v.outcome].toLowerCase()}${v.value != null && v.outcome !== 'denied' ? ` at ${fmt(v.policyId, v.value)}` : ''}; without the graph’s structure the agent would have answered differently.`
            : 'Here the vector-only agent lands on the same answer, but with no way to show that its precedent is still good law.'}
        </p>
      </div>
    </aside>
  );
}

export function SlipOpinion({
  verdict: v,
  ablation,
  actor,
  onStrike,
}: {
  verdict: Verdict;
  ablation: Ablation | null;
  actor: string;
  /** Told when the structure-off view opens or closes, so the page can make room for it. */
  onStrike?: (on: boolean) => void;
}) {
  const { personName } = useDesk();
  const [struck, setStruck] = useState(false);
  const notRelied = v.candidates.filter((c) => c.covers && c.standing.flag !== 'green');
  const notCovering = v.candidates.filter((c) => !c.covers).length;
  const citedIds = new Set(v.citations.map((c) => c.id));

  const seed = useMemo(() => {
    const s: Record<string, Known> = {};
    for (const c of v.candidates) s[c.id] = { account: c.account, flag: c.standing.flag, codes: c.standing.reasons.map((r) => r.code) };
    return s;
  }, [v.candidates]);
  const chainIds = useMemo(
    () => [...notRelied.flatMap((c) => c.standing.chain), ...(ablation?.precedent?.standing.chain ?? [])],
    [notRelied, ablation],
  );
  const known = useKnown(seed, chainIds);

  const account = v.account?.name ?? v.intake.accountName ?? 'Unnamed customer';
  const policy = v.policyId;
  const violations = [...v.limitViolations, ...v.defaultViolations];

  return (
    <div className={`opinion-wrap${struck && ablation ? ' split' : ''}`}>
      <article className={`paper opinion${struck ? ' struck' : ''}`} aria-label="Slip opinion">
        <header className="op-head">
          <div>
            <p className="op-court">Northwind Cloud exception desk, slip opinion</p>
            <h2 className="op-title">
              <i>{account}</i> v. {actorName(actor, personName)}
            </h2>
            <p className="op-meta">
              {policy ? `${POLICY_NAME[policy]} (${v.policyVersionId ?? 'no version in force'})` : 'No policy identified'}
              {v.requested != null ? `, ${fmt(policy, v.requested)} requested` : ''}
              {v.intake.reason ? ` for ${reason(v.intake.reason)}` : ''}
              {v.intake.days != null ? `, ${v.intake.days} days after the charge` : ''}. {date(v.at)}
              {v.dryRun ? ', dry run' : ''}.
            </p>
          </div>
          <div className="op-stamp">
            <Stamp outcome={v.outcome} stampKey={v.at} />
            <span className="op-granted">
              <b>{granted(v)}</b>
            </span>
          </div>
        </header>

        <div className="op-tools">
          <span>
            {v.ledgerSeq != null ? `Ledger #${v.ledgerSeq}` : 'Not recorded'}
            {v.caseId ? `, case ${v.caseId}` : ''}
          </span>
          {ablation ? (
            <button
              type="button"
              className="switch"
              aria-pressed={struck}
              onClick={() => {
                setStruck(!struck);
                onStrike?.(!struck);
              }}
            >
              <span className="switch-track" aria-hidden="true" />
              Strike the citations
            </button>
          ) : null}
        </div>

        <section className="op-section">
          <h3 className="op-h">Holding</h3>
          <p className="op-holding strikeable">{v.explanation}</p>
          {v.refusal ? (
            <p className="op-refusal">
              <code>{v.refusal.code}</code>
              <span>{v.refusal.detail}</span>
            </p>
          ) : null}
          {violations.length ? (
            <ul className="clauses">
              {violations.map((c) => (
                <li key={c.clauseId}>
                  <code>{c.key}</code>
                  <span>
                    {c.text ?? c.clauseId} Asked: {clauseActual(c, policy)}.
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {v.ignoredClaims.length ? (
            <p className="op-note">
              Not relied on, because a claim in a request is not evidence:{' '}
              {v.ignoredClaims.map((c, i) => (
                <span key={c}>
                  {i ? '; ' : ''}
                  <span className="op-claim">“{c}”</span>
                </span>
              ))}
            </p>
          ) : null}
          <p className="op-note">
            Explanation written by {v.explanationSource === 'model' ? 'the model from the desk’s findings' : 'the desk’s template'};
            the outcome was decided by the graph.
          </p>
        </section>

        <section className="op-section">
          <h3 className="op-h">Headnotes</h3>
          {v.citations.length ? (
            <ol className="headnotes">
              {v.citations.map((c) => (
                <Citation key={c.id} c={c} policy={policy} />
              ))}
            </ol>
          ) : v.rule ? (
            <p className="cite strikeable">
              Standing rule <code>{v.rule.id}</code>: {v.rule.text}
            </p>
          ) : (
            <p className="op-note" style={{ marginTop: 0 }}>
              {v.basis === 'routine'
                ? 'Inside the policy as written; no precedent needed.'
                : v.basis === 'policy'
                  ? 'Decided on the policy in force; no precedent can override a hard limit.'
                  : 'No precedent cited.'}
            </p>
          )}
        </section>

        {notRelied.length ? (
          <section className="op-section">
            <h3 className="op-h">Not relied on</h3>
            <ul className="not-relied">
              {notRelied
                .filter((c) => !citedIds.has(c.id))
                .map((c) => (
                  <li key={c.id}>
                    <ChainLine id={c.id} account={c.account} standing={c.standing} known={known} />
                    <span className="op-note" style={{ marginTop: 0 }}>
                      {c.standing.reasons.map((r) => CODE_GLOSS[r.code] ?? r.detail).join('; ')}.{' '}
                      {c.standing.reasons.map((r) => (
                        <CodeChip key={r.code + r.nodeId} code={r.code} />
                      ))}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}

        <section className="op-section">
          <h3 className="op-h">Chain of commission</h3>
          <Commission v={v} actor={actor} />
          {notCovering ? (
            <p className="op-note">
              {notCovering} other {notCovering === 1 ? 'precedent was' : 'precedents were'} considered and do not cover these
              facts.
            </p>
          ) : null}
        </section>

        <footer className="op-footer">
          <span>{v.decisionId ? `Decision ${v.decisionId}` : v.escalationId ? `Escalation ${v.escalationId}` : 'No decision recorded'}</span>
          {v.decisionId ? <Link href={`/desk/decision/${v.decisionId}`}>Read the full opinion</Link> : null}
          {v.escalationId ? <Link href="/desk/approvals">Rule on it in Approvals</Link> : null}
        </footer>

        {v.trace.length ? <Appendix trace={v.trace} /> : null}
      </article>
      {struck && ablation ? <Unbound a={ablation} v={v} known={known} /> : null}
    </div>
  );
}
