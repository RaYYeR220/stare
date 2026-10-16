'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Failure, Loading, Meter, PageHead } from '@/components/bits';
import { Glyph } from '@/components/Glyph';
import { useDesk } from '@/lib/desk';
import { count, date, FLAG_NAME, money, POLICY_NAME } from '@/lib/format';
import type { AdoptResult, Flag, ImpactReport, PolicyId, PolicyVersion } from '@/lib/types';
import { useResource } from '@/lib/useResource';

interface Rule {
  field: string;
  op: string;
  value: unknown;
}

function parse(rule: string): Rule | null {
  try {
    return JSON.parse(rule) as Rule;
  } catch {
    return null;
  }
}

const POLICIES: PolicyId[] = ['refunds', 'discounts', 'payment_terms'];
const FOREVER = 253402300799000;

function unitWord(policy: PolicyId, field: string): string {
  if (field === 'days') return 'days';
  if (policy === 'refunds') return 'dollars';
  if (policy === 'discounts') return 'percent';
  return 'days';
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))} s</>;
}

function Report({ r, policy }: { r: ImpactReport; policy: PolicyId }) {
  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="figures">
        <div className="figure">
          <div className="figure-value">{count(r.becameRed)}</div>
          <div className="figure-label">precedents stop being good law</div>
        </div>
        <div className="figure">
          <div className="figure-value">{count(r.becameYellow)}</div>
          <div className="figure-label">turn to Overruling Risk</div>
        </div>
        <div className="figure">
          <div className="figure-value">{policy === 'refunds' ? money(r.exposure) : count(r.rulesQuarantined.length)}</div>
          <div className="figure-label">{policy === 'refunds' ? 'granted on precedent that is now red' : 'standing rules quarantined'}</div>
        </div>
      </div>

      <div>
        <h3 className="op-h" style={{ color: 'var(--ink-3)' }}>
          Flag transitions
        </h3>
        {r.transitions.length ? (
          <ul className="transitions">
            {r.transitions.map((t) => (
              <li key={`${t.from}${t.to}`}>
                <Glyph signal={t.from as Flag} />
                <span className="muted">to</span>
                <Glyph signal={t.to as Flag} />
                <span>
                  {count(t.count)} {t.count === 1 ? 'decision' : 'decisions'}, {FLAG_NAME[t.from as Flag]} to {FLAG_NAME[t.to as Flag]}:
                </span>
                <span style={{ fontSize: 13 }}>
                  {t.ids.slice(0, 6).map((id, i) => (
                    <span key={id}>
                      {i ? ', ' : ''}
                      <Link href={`/desk/decision/${id}`}>{id}</Link>
                    </span>
                  ))}
                  {t.ids.length > 6 ? `, and ${t.ids.length - 6} more` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No precedent changes flag under this draft.</p>
        )}
      </div>

      <div className="slope">
        <h3 className="op-h" style={{ color: 'var(--ink-3)' }}>
          Autonomy on the last {r.autonomy.sample} cases
        </h3>
        <Meter label="Settled by the agent today" remaining={r.autonomy.before} cap={100} format={(v) => `${v}%`} of="of the cases" />
        <Meter label="Settled by the agent under the draft" remaining={r.autonomy.after} cap={100} format={(v) => `${v}%`} of="of the cases" />
        <p className="muted" style={{ fontSize: 13 }}>
          The share of recent requests the agent would settle itself (approved or counter-offered) instead of escalating.
        </p>
      </div>

      {r.rulesQuarantined.length ? (
        <div>
          <h3 className="op-h" style={{ color: 'var(--ink-3)' }}>
            Standing rules quarantined
          </h3>
          <ul className="ruled-list">
            {r.rulesQuarantined.map((q) => (
              <li key={q.id}>
                <code>{q.id}</code> {q.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="muted" style={{ fontSize: 12.5 }}>
        Simulated on <code>{r.whatIfGraph}</code>, a copy of your graph dropped afterwards, in {(r.ms / 1000).toFixed(1)} s.
      </p>
    </div>
  );
}

export default function Policy() {
  const { api, version, session, touch } = useDesk();
  const policies = useResource((s) => api.policies(s), `${session?.token}:${version}`);
  const [policy, setPolicy] = useState<PolicyId>('refunds');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<number | null>(null);
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adopted, setAdopted] = useState<AdoptResult | null>(null);

  const versions = (policies.data ?? []).filter((v) => v.policyId === policy).sort((a, b) => a.version - b.version);
  const current: PolicyVersion | undefined = versions.find((v) => v.current);
  const limits = useMemo(
    () =>
      (current?.clauses ?? [])
        .map((c) => ({ c, rule: parse(c.rule) }))
        .filter((x) => x.c.kind === 'limit' && x.rule && typeof x.rule.value === 'number'),
    [current],
  );

  const versionKey = `${policy}:${current?.versionId ?? ''}`;
  useEffect(() => {
    setDraft(Object.fromEntries(limits.map(({ c, rule }) => [c.key, String(rule?.value ?? '')])));
  }, [versionKey]);

  useEffect(() => {
    setReport(null);
    setError(null);
    setAdopted(null);
  }, [policy]);

  const changes = limits
    .filter(({ c, rule }) => draft[c.key] !== undefined && draft[c.key] !== '' && Number(draft[c.key]) !== rule?.value)
    .map(({ c }) => ({ key: c.key, value: Number(draft[c.key]) }));

  const simulate = async () => {
    setRunning(Date.now());
    setError(null);
    setReport(null);
    setAdopted(null);
    try {
      setReport(await api.impact(policy, changes));
    } catch (e) {
      setError(e as Error);
    } finally {
      setRunning(null);
    }
  };

  const adopt = async () => {
    setAdopting(true);
    setError(null);
    try {
      setAdopted(await api.adopt(policy, changes));
      touch();
    } catch (e) {
      setError(e as Error);
    } finally {
      setAdopting(false);
    }
  };

  return (
    <>
      <PageHead title="Policy">
        Every version of every policy is in the graph with its clauses, so a precedent is judged against the policy in force
        today. Draft a change to the hard limits, see which precedent it would re-flag on a copy of the graph, then adopt it.
      </PageHead>

      <div className="tabs" role="tablist" aria-label="Policies">
        {POLICIES.map((p) => (
          <button key={p} type="button" role="tab" className="tab" aria-selected={policy === p} onClick={() => setPolicy(p)}>
            {POLICY_NAME[p]}
          </button>
        ))}
      </div>

      {policies.error ? <Failure error={policies.error} retry={policies.reload}>The policies did not load.</Failure> : null}
      {!policies.data && policies.loading ? <Loading>Reading policy versions</Loading> : null}

      {versions.length ? (
        <div className="versions">
          {versions.map((v) => (
            <section key={v.versionId} className="version" data-current={v.current ? 'true' : 'false'}>
              <div className="version-head">
                <h2 className="h3">Version {v.version}</h2>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {v.current ? 'in force' : 'superseded'}
                </span>
              </div>
              <p className="muted" style={{ fontSize: 12.5 }}>
                <code>{v.versionId}</code>, from {date(v.from)}
                {v.to < FOREVER ? ` to ${date(v.to)}` : ''}
              </p>
              <ul>
                {v.clauses.map((c) => (
                  <li key={c.key}>
                    <code>{c.key}</code>
                    <span>
                      {c.text} <span className="muted">({c.kind === 'limit' ? 'hard limit' : 'default'})</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}

      {current ? (
        <div className="sim">
          <form
            className="sim-form"
            onSubmit={(e) => {
              e.preventDefault();
              void simulate();
            }}
          >
            <h2 className="h3">Draft version {current.version + 1}</h2>
            <p className="muted" style={{ fontSize: 13.5 }}>
              Edit the hard limits of {current.versionId}. Nothing is written until you adopt.
            </p>
            {limits.map(({ c, rule }) => (
              <div key={c.key} className="limit-row">
                <p>
                  <code>{c.key}</code> {c.text}
                </p>
                <label className="field" htmlFor={`lim-${c.key}`}>
                  <span className="visually-hidden">
                    {c.key} limit in {unitWord(policy, rule?.field ?? '')}
                  </span>
                  <input
                    id={`lim-${c.key}`}
                    className="input"
                    type="number"
                    min={0}
                    value={draft[c.key] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
                  />
                </label>
              </div>
            ))}
            <div className="row">
              <button type="submit" className="btn" disabled={running !== null || !changes.length}>
                {running !== null ? 'Simulating' : 'Simulate on a copy'}
              </button>
              {!changes.length ? <span className="muted" style={{ fontSize: 13 }}>Change a limit to simulate.</span> : null}
            </div>
          </form>

          <div aria-live="polite">
            {running !== null ? (
              <Loading>
                Copying your graph, adopting the draft there and replaying recent cases through the engine. This takes about a
                minute, <Elapsed since={running} />
              </Loading>
            ) : null}
            {error ? <Failure error={error}>The simulation did not finish.</Failure> : null}
            {report ? (
              <>
                <Report r={report} policy={policy} />
                <div className="row" style={{ marginTop: 24 }}>
                  <button type="button" className="btn" onClick={() => void adopt()} disabled={adopting || adopted !== null}>
                    {adopting ? 'Adopting' : adopted ? 'Adopted' : `Adopt version ${current.version + 1}`}
                  </button>
                  <span className="muted" style={{ fontSize: 13 }}>
                    Writes a new policy version to your desk’s graph and the ledger.
                  </span>
                </div>
              </>
            ) : !running && !error ? (
              <p className="state-empty" style={{ color: 'var(--ink-3)' }}>
                The impact report appears here: what turns red, what turns to Overruling Risk, which rules are quarantined and
                how much the agents can still settle alone.
              </p>
            ) : null}
            {adopted ? (
              <div className="ok-note" role="status" style={{ marginTop: 20 }}>
                <p>
                  Adopted <code>{adopted.versionId}</code> as version {adopted.version}, ledger #{adopted.ledgerSeq}.
                  {adopted.quarantined.length ? ` Quarantined: ${adopted.quarantined.join(', ')}.` : ''}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
