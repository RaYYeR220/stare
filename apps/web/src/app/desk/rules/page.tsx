'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Empty, Failure, Loading, PageHead } from '@/components/bits';
import { PersonSelect } from '@/components/desk/ActorSelect';
import { Signal, type SignalKind } from '@/components/Glyph';
import { useDesk } from '@/lib/desk';
import { date, POLICY_NAME, reason, value as fmt } from '@/lib/format';
import type { RatifyResult, RuleView } from '@/lib/types';
import { useAction, useResource } from '@/lib/useResource';

const STATUS: Record<string, { signal: SignalKind; label: string }> = {
  ratified: { signal: 'green', label: 'Ratified, in force' },
  proposed: { signal: 'pending', label: 'Proposed, awaiting ratification' },
  quarantined: { signal: 'red', label: 'Quarantined: its basis is no longer good law' },
};

function Ratify({ rule, onDone }: { rule: RuleView; onDone: () => void }) {
  const { api, people } = useDesk();
  const covering = people
    .filter((p) => p.active)
    .map((p) => ({ id: p.id, cap: p.authority.find((a) => a.policy === rule.policyId)?.cap ?? -1 }))
    .filter((x) => x.cap >= rule.maxValue)
    .sort((a, b) => a.cap - b.cap);
  const [personId, setPersonId] = useState(covering[0]?.id ?? 'p-maya');
  const act = useAction((pid: string) => api.ratify(rule.id, pid));
  const r: RatifyResult | null = act.result;
  return (
    <div className="ruling">
      <PersonSelect id={`r-${rule.id}`} value={personId} onChange={setPersonId} label="Ratify as" policy={rule.policyId} />
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={act.pending}
          onClick={async () => {
            const res = await act.run(personId);
            if (res?.ok) onDone();
          }}
        >
          {act.pending ? 'Ratifying' : 'Ratify this rule'}
        </button>
      </div>
      {act.error ? <Failure error={act.error}>The rule was not ratified.</Failure> : null}
      {r && !r.ok ? (
        <div className="refusal" role="alert">
          <span className="refusal-code">REFUSED</span>
          <p className="refusal-text">{r.refusal}</p>
        </div>
      ) : null}
      {r?.ok ? <p className="pass">Ratified, ledger #{r.ledgerSeq}.</p> : null}
    </div>
  );
}

function Skill() {
  const { api } = useDesk();
  const act = useAction(() => api.skill());
  const [open, setOpen] = useState(false);
  const download = () => {
    if (!act.result) return;
    const url = URL.createObjectURL(new Blob([act.result], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'SKILL.md';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section style={{ marginTop: 48 }} aria-labelledby="skill-title">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 id="skill-title" className="h3">
            SKILL.md
          </h2>
          <p className="muted" style={{ fontSize: 14, marginTop: 4 }}>
            The ratified rules compiled into a skill an agent runtime can load, regenerated from the graph each time.
          </p>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setOpen(true);
              void act.run();
            }}
            disabled={act.pending}
          >
            {act.pending ? 'Compiling' : act.result ? 'Compile again' : 'Compile SKILL.md'}
          </button>
          {act.result ? (
            <button type="button" className="btn btn-quiet" onClick={download}>
              Download
            </button>
          ) : null}
        </div>
      </div>
      {act.error ? <Failure error={act.error}>SKILL.md could not be compiled.</Failure> : null}
      {open && act.result ? (
        <pre className="pre pre-wrap" style={{ marginTop: 16, maxHeight: 480 }}>
          {act.result}
        </pre>
      ) : null}
    </section>
  );
}

export default function Rules() {
  const { api, version, session, touch } = useDesk();
  const rules = useResource((s) => api.rules(s), `${session?.token}:${version}`);
  const propose = useAction(() => api.proposeRules());

  const groups = ['ratified', 'proposed', 'quarantined'].map((st) => ({ st, rows: (rules.data ?? []).filter((r) => r.status === st) }));
  const other = (rules.data ?? []).filter((r) => !STATUS[r.status]);

  return (
    <>
      <PageHead
        title="Standing rules"
        aside={
          <button
            type="button"
            className="btn"
            disabled={propose.pending}
            onClick={async () => {
              await propose.run();
              touch();
            }}
          >
            {propose.pending ? 'Looking for patterns' : 'Propose rules from precedent'}
          </button>
        }
      >
        When the same exception keeps being granted on good law, the desk proposes it as a rule. A person whose authority
        covers its ceiling ratifies it; the rule is quarantined the moment any decision it rests on stops being good law.
      </PageHead>

      {propose.result ? (
        <p className="ok-note" role="status" style={{ marginBottom: 24 }}>
          {propose.result.created.length
            ? `Proposed ${propose.result.created.join(', ')}.`
            : 'No new pattern: every group of three or more good-law exceptions already has a rule.'}
        </p>
      ) : null}
      {propose.error ? <Failure error={propose.error}>Proposing rules failed.</Failure> : null}
      {rules.error ? <Failure error={rules.error} retry={rules.reload}>The rules did not load.</Failure> : null}
      {!rules.data && rules.loading ? <Loading>Reading the standing rules</Loading> : null}
      {rules.data && !rules.data.length ? <Empty>No standing rules yet. Propose some from precedent.</Empty> : null}

      <div style={{ opacity: rules.loading && rules.data ? 0.6 : 1 }}>
        {[...groups, { st: 'other', rows: other }].map(({ st, rows }) =>
          rows.map((r) => {
            const s = STATUS[r.status] ?? { signal: 'questioned' as SignalKind, label: r.status };
            return (
              <article key={r.id} className="rule-item">
                <div>
                  <Signal signal={s.signal}>{s.label}</Signal>
                  <p className="rule-text">{r.text}</p>
                  <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                    <code>{r.id}</code>, {POLICY_NAME[r.policyId]}, {reason(r.reason)}, tiers {r.tiers.join(' and ')}, ceiling{' '}
                    {fmt(r.policyId, r.maxValue)}
                    {r.ratifiedBy ? `. Ratified by ${r.ratifiedBy}, ${date(r.ratifiedAt)}` : ''}.
                  </p>
                  <ul className="basis" aria-label="Basis">
                    {r.basis.map((b) => (
                      <li key={b.id}>
                        <Link href={`/desk/decision/${b.id}`}>
                          <i>{b.account}</i>
                        </Link>
                        , {b.id}, {date(b.at)}, {fmt(r.policyId, b.value)}
                      </li>
                    ))}
                  </ul>
                </div>
                {st === 'proposed' ? <Ratify rule={r} onDone={touch} /> : <div />}
              </article>
            );
          }),
        )}
      </div>

      <Skill />
    </>
  );
}
