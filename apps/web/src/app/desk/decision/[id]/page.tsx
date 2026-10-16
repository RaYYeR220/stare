'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Empty, Failure, Loading, Stamp } from '@/components/bits';
import { PersonSelect } from '@/components/desk/ActorSelect';
import { CodeChip } from '@/components/desk/chain';
import { Plate, type PlateNode } from '@/components/desk/Plate';
import { Glyph, Signal } from '@/components/Glyph';
import { useDesk } from '@/lib/desk';
import { AGENT_NAME, CODE_GLOSS, date, dateTime, FLAG_NAME, POLICY_NAME, short, value as fmt } from '@/lib/format';
import type { DecisionView, OverturnResult, Standing } from '@/lib/types';
import { useResource } from '@/lib/useResource';

interface Follower {
  id: string;
  account: string;
  standing: Standing;
  value: number | null;
  at: number;
  madeBy: string | null;
}

function StandingBlock({ s }: { s: Standing }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Signal signal={s.flag}>{FLAG_NAME[s.flag]}, as of now</Signal>
      {s.reasons.length ? (
        <ul className="reasons">
          {s.reasons.map((r) => (
            <li key={r.code + r.nodeId}>
              <CodeChip code={r.code} />
              <span>
                {CODE_GLOSS[r.code] ?? r.code}: {r.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="op-note" style={{ marginTop: 0 }}>
          Nothing in its chain has been overturned, superseded, decided without authority or under a conflict.
        </p>
      )}
    </div>
  );
}

function authorName(id: string, personName: (id: string) => string): string {
  return AGENT_NAME[id] ?? personName(id);
}

export default function DecisionPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const { api, touch, version, session, personName } = useDesk();
  const view = useResource((s) => api.decision(id, s), `${session?.token}:${id}:${version}`);
  const [personId, setPersonId] = useState('p-daniel');
  const [why, setWhy] = useState('Overturned on review: the facts did not support the exception.');
  const [pending, setPending] = useState(false);
  const [overturn, setOverturn] = useState<OverturnResult | null>(null);
  const [overturnError, setOverturnError] = useState<Error | null>(null);
  const [followers, setFollowers] = useState<Follower[]>([]);

  useEffect(() => {
    setOverturn(null);
    setFollowers([]);
  }, [id]);

  // after a reversal, read every decision that rested on this one: their live flags are the point
  useEffect(() => {
    if (!overturn?.ok || !overturn.affected.length) return;
    let live = true;
    Promise.all(
      overturn.affected.slice(0, 12).map((fid) =>
        api
          .decision(fid)
          .then((v): Follower => ({ id: fid, account: v.decision.account ?? fid, standing: v.decision.standing, value: v.decision.value, at: v.decision.at, madeBy: v.decision.madeBy }))
          .catch(() => null),
      ),
    ).then((rows) => {
      if (live) setFollowers(rows.filter((r): r is Follower => r !== null));
    });
    return () => {
      live = false;
    };
  }, [overturn, api]);

  const plate = useMemo(() => {
    const v: DecisionView | null = view.data;
    if (!v) return null;
    const d = v.decision;
    const overturnedBy = new Map(v.reversals.map((r) => [r.target, `${r.by}${r.person ? ` (${r.person})` : ''}`]));
    const nodes = new Map<string, PlateNode>();
    nodes.set(d.id, { id: d.id, account: d.account ?? d.id, value: d.value, at: d.at, madeBy: d.madeBy, flag: d.standing.flag, overturnedBy: overturnedBy.get(d.id) });
    for (const c of v.chain) {
      nodes.set(c.to, { id: c.to, account: c.account, value: c.value, at: c.at, madeBy: c.madeBy, flag: c.standing.flag, overturnedBy: overturnedBy.get(c.to) });
    }
    for (const f of followers) nodes.set(f.id, { id: f.id, account: f.account, value: f.value, at: f.at, madeBy: f.madeBy, flag: f.standing.flag });
    return { nodes: [...nodes.values()], edges: v.chain.map((c) => ({ from: c.from, to: c.to })) };
  }, [view.data, followers]);

  if (view.error && !view.data) {
    return (
      <div style={{ paddingTop: 40 }}>
        <Failure error={view.error} retry={view.reload}>
          Decision {id} could not be read.
        </Failure>
        <p style={{ marginTop: 16 }}>
          <Link href="/desk">Back to the advance sheets</Link>
        </p>
      </div>
    );
  }
  if (!view.data) return <Loading>Setting the opinion for {id}</Loading>;

  const { decision: d, reversals, sources } = view.data;
  const policy = d.policyId;
  const alreadyOverturned = d.standing.reasons.some((r) => r.code === 'OVERTURNED');

  const doOverturn = async () => {
    setPending(true);
    setOverturnError(null);
    try {
      const r = await api.overturn(d.id, personId, why);
      setOverturn(r);
      if (r.ok) touch();
    } catch (e) {
      setOverturnError(e as Error);
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ paddingTop: 32 }}>
      <p className="muted" style={{ marginBottom: 16, fontSize: 13.5 }}>
        <Link href="/desk">Advance sheets</Link>, opinion {d.id}
      </p>

      <article className="paper headnote-page" aria-label="Headnote page">
        <header className="op-head">
          <div>
            <p className="op-court">Northwind Cloud exception desk, {policy ? POLICY_NAME[policy].toLowerCase() : 'exceptions'}</p>
            <h1 className="op-title" style={{ fontSize: 'clamp(30px, 3.4vw, 44px)' }}>
              <i>{d.account ?? 'Unknown customer'}</i> v. {d.madeBy ?? 'unknown'}
            </h1>
            <p className="op-meta">
              {d.id}, decided {date(d.at)}, under {d.policyVersion ?? 'no recorded policy version'}
              {d.basis ? `, on ${d.basis === 'human' ? 'a person’s ruling' : d.basis}` : ''}.
            </p>
          </div>
          <div className="op-stamp">
            <Stamp outcome={d.outcome} stampKey={`${d.id}${d.standing.flag}`} />
            <span className="op-granted">
              <b>{d.outcome === 'denied' ? 'Nothing granted' : fmt(policy, d.value)}</b>
              {d.requested != null && d.requested !== d.value ? ` of ${fmt(policy, d.requested)} asked` : ''}
            </span>
          </div>
        </header>

        <div className="hp-grid">
          <div>
            <h2 className="op-h">Standing</h2>
            <StandingBlock s={d.standing} />
            <h2 className="op-h" style={{ marginTop: 28 }}>
              Opinion
            </h2>
            <p className="op-holding">{d.narrative ?? 'No narrative was recorded for this decision.'}</p>
            {d.rule ? <p className="op-note">Applied the standing rule: {d.rule}</p> : null}
            {d.request ? (
              <>
                <h2 className="op-h" style={{ marginTop: 28 }}>
                  The request
                </h2>
                <p className="hp-request">{d.request}</p>
              </>
            ) : null}
          </div>
          <div>
            <h2 className="op-h">Record</h2>
            <dl className="facts">
              <dt>Decided by</dt>
              <dd>
                {d.madeBy ?? 'unknown'} {d.makerKind ? `(${d.makerKind === 'Agent' ? 'agent' : 'person'})` : ''}
              </dd>
              {d.onAuthorityOf ? (
                <>
                  <dt>On authority of</dt>
                  <dd>{d.onAuthorityOf}</dd>
                </>
              ) : null}
              <dt>Account</dt>
              <dd>
                {d.account ?? 'unknown'}
                {d.tier ? `, ${d.tier} tier` : ''}
              </dd>
              <dt>Case</dt>
              <dd className="mono">{d.caseId ?? 'none'}</dd>
              <dt>Ledger</dt>
              <dd>
                {d.ledgerSeq != null ? `#${d.ledgerSeq}` : 'not recorded'} <code title={d.ledgerHash ?? ''}>{short(d.ledgerHash, 16)}</code>
              </dd>
              <dt>Policy</dt>
              <dd className="mono">{d.policyVersion ?? 'none'}</dd>
            </dl>
          </div>
        </div>
      </article>

      <section className="plate" aria-labelledby="plate-title">
        <div className="plate-head">
          <h2 id="plate-title" className="kicker-sc">
            Appendix plate: the precedent chain
          </h2>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {view.data.chain.length ? `${view.data.chain.length} citation links, up to four hops, flags as of now` : 'This decision cites no precedent'}
          </span>
        </div>
        {plate ? (
          <div className="plate-scroll">
            <Plate rootId={d.id} nodes={plate.nodes} edges={plate.edges} followers={followers.map((f) => f.id)} policy={policy} />
          </div>
        ) : null}
        <div className="plate-legend">
          <span>
            <code>f</code> followed (cites)
          </span>
          <span>
            <code style={{ color: 'var(--sig-red)' }}>o</code> overturned
          </span>
          <span>
            <Glyph signal="green" /> good law
          </span>
          <span>
            <Glyph signal="yellow" /> Overruling Risk
          </span>
          <span>
            <Glyph signal="red" /> not good law
          </span>
          {followers.length ? <span>left of the decision: what rests on it</span> : null}
        </div>
      </section>

      <div className="dp-columns">
        <div className="stack" style={{ gap: 32 }}>
          <section>
            <h2 className="h3">Reversals</h2>
            {reversals.length ? (
              <ul className="ruled-list" style={{ marginTop: 12 }}>
                {reversals.map((r) => (
                  <li key={r.by + r.target}>
                    <p>
                      <Link href={`/desk/decision/${r.target}`}>{r.target}</Link> overturned by{' '}
                      <Link href={`/desk/decision/${r.by}`}>{r.by}</Link>
                      {r.person ? `, ${r.person}` : ''}, {date(r.at)}
                    </p>
                    <p className="muted" style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 16 }}>
                      “{r.reason}”
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Nothing in this chain has been overturned.</Empty>
            )}
          </section>

          <section>
            <h2 className="h3">Sources</h2>
            <p className="muted" style={{ fontSize: 13.5, margin: '6px 0 14px' }}>
              The messages this decision is grounded in, as stored in the graph.
            </p>
            {sources.length ? (
              <ul className="sources">
                {sources.map((s) => (
                  <li key={s.id} className={`source${s.certificateHash ? ' tombstone' : ''}`}>
                    <div className="source-meta">
                      <span>
                        {s.channel ?? s.kind}
                        {s.title ? `, ${s.title}` : ''}
                      </span>
                      <span>{s.at ? dateTime(s.at) : ''}</span>
                    </div>
                    {s.certificateHash ? (
                      <>
                        <span className="blank-bar" style={{ width: '92%' }} />
                        <span className="blank-bar" style={{ width: '64%' }} />
                        <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                          Erased under certificate <code>{short(s.certificateHash, 16)}</code>
                        </p>
                      </>
                    ) : (
                      <p className="source-text">{s.text}</p>
                    )}
                    {s.author ? (
                      <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                        {s.author.startsWith('p-') || s.author.startsWith('a-') ? authorName(s.author, personName) : <code>{s.author}</code>}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No source messages are linked to this decision.</Empty>
            )}
          </section>
        </div>

        <section className="stack" style={{ alignContent: 'start' }}>
          <h2 className="h3">Overturn</h2>
          <p className="muted" style={{ fontSize: 14 }}>
            A reversal is itself a decision, recorded in the ledger. Everything that cites this one turns to Overruling Risk
            at once, and any standing rule resting on it is quarantined.
          </p>
          <div className="overturn-form">
            <PersonSelect id="overturn-person" value={personId} onChange={setPersonId} label="Ruling as" policy={policy} />
            <label className="field" htmlFor="overturn-reason">
              <span className="field-label">Reason, as it will be recorded</span>
              <input id="overturn-reason" className="input" value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} />
            </label>
            <div className="row">
              <button type="button" className="btn btn-danger" disabled={pending || alreadyOverturned} onClick={() => void doOverturn()}>
                {pending ? 'Recording the reversal' : 'Overturn this decision'}
              </button>
              {alreadyOverturned ? <span className="muted">Already overturned.</span> : null}
            </div>
          </div>
          {overturnError ? <Failure error={overturnError}>The reversal was not recorded.</Failure> : null}
          {overturn && !overturn.ok ? (
            <div className="refusal" role="alert">
              <span className="refusal-code">NOT RECORDED</span>
              <p className="refusal-text">The desk did not record the reversal: the person acting has left the company, or the decision has no case on file.</p>
            </div>
          ) : null}
          {overturn?.ok ? (
            <div className="ok-note" role="status">
              <p>
                Overturned by <Link href={`/desk/decision/${overturn.decisionId}`}>{overturn.decisionId}</Link>
                {overturn.ledgerSeq != null ? `, ledger #${overturn.ledgerSeq}` : ''}.
              </p>
              <p className="muted" style={{ fontSize: 14 }}>
                {overturn.affected.length
                  ? `${overturn.affected.length} ${overturn.affected.length === 1 ? 'decision rests' : 'decisions rest'} on it, directly or through others. Their flags now:`
                  : 'Nothing cites it, so no other precedent changed.'}
              </p>
              {followers.length ? (
                <ul className="stack" style={{ gap: 6, listStyle: 'none' }}>
                  {followers.map((f) => (
                    <li key={f.id} className="row" style={{ gap: 8 }}>
                      <Glyph signal={f.standing.flag} />
                      <Link href={`/desk/decision/${f.id}`}>
                        <i style={{ fontFamily: 'var(--serif)', fontSize: 16 }}>{f.account}</i>
                      </Link>
                      <span className="muted" style={{ fontSize: 13 }}>
                        {f.id}, {FLAG_NAME[f.standing.flag]}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : overturn.affected.length ? (
                <Loading>Reading their standing</Loading>
              ) : null}
              {overturn.quarantined.length ? (
                <p style={{ fontSize: 14 }}>
                  Quarantined standing {overturn.quarantined.length === 1 ? 'rule' : 'rules'}: {overturn.quarantined.join(', ')}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
