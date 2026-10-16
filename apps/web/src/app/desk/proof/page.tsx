'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Failure, Loading, PageHead } from '@/components/bits';
import { Glyph } from '@/components/Glyph';
import { TableOfCases } from '@/components/landing/TableOfCases';
import { publicApi } from '@/lib/api';
import { useDesk } from '@/lib/desk';
import { count, dateTime, FLAG_NAME, money, POLICY_NAME, reason, short, value as fmt } from '@/lib/format';
import type { Flag, RaceReport } from '@/lib/types';
import { useResource } from '@/lib/useResource';

const TABS = [
  { id: 'race', label: 'Race' },
  { id: 'isolation', label: 'Isolation' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'evaluation', label: 'Evaluation' },
  { id: 'algorithms', label: 'Algorithms' },
] as const;
type Tab = (typeof TABS)[number]['id'];

function Mark({ pass }: { pass: boolean }) {
  return <span className={`verdict-mark ${pass ? 'pass' : 'fail'}`}>{pass ? 'Holds' : 'Broken'}</span>;
}

function Race() {
  const { api, touch } = useDesk();
  const [pending, setPending] = useState(false);
  const [report, setReport] = useState<RaceReport | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const run = async () => {
    setPending(true);
    setError(null);
    try {
      setReport(await api.race());
      touch();
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };
  const unitFmt = (unit: string) => (unit === 'usd' ? money : (v: number) => count(v));
  return (
    <div className="stack" style={{ gap: 28 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p style={{ maxWidth: '40em', color: 'var(--ink-2)' }}>
          Sixty-four requests at once over sixteen connections, some of them retries of the same request. The budget is
          re-checked and spent inside the same write that records the decision, so no grant can race past it. It runs on a throwaway copy
          of this desk, so your own budgets are untouched.
        </p>
        <button type="button" className="btn" onClick={() => void run()} disabled={pending}>
          {pending ? 'Racing' : report ? 'Run it again' : 'Run the race'}
        </button>
      </div>
      {pending ? <Loading>Firing 64 requests over 16 connections</Loading> : null}
      {error ? <Failure error={error}>The race did not finish.</Failure> : null}
      {report ? (
        <>
          <div className="figures">
            <div className="figure">
              <div className="figure-value">{count(report.requests)}</div>
              <div className="figure-label">
                requests, {count(report.uniqueCases)} distinct cases, {report.connections} connections
              </div>
            </div>
            <div className="figure">
              <ul className="outcome-list">
                {Object.entries(report.outcomes)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <li key={k}>
                      <b>{v}</b> {k}
                    </li>
                  ))}
              </ul>
              <div className="figure-label">outcomes</div>
            </div>
            <div className="figure">
              <div className="figure-value">{(report.ms / 1000).toFixed(1)} s</div>
              <div className="figure-label">ledger {report.ledger.ok ? 'verifies' : 'broken'}, {count(report.ledger.length)} entries</div>
            </div>
          </div>
          <section>
            <h2 className="h3" style={{ marginBottom: 12 }}>
              Invariants
            </h2>
            <ul className="inv-list">
              {report.invariants.map((i) => (
                <li key={i.name}>
                  <span>{i.name}</span>
                  <Mark pass={i.pass} />
                  <span className="inv-detail">{i.detail}</span>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="h3" style={{ marginBottom: 12 }}>
              Budgets before and after
            </h2>
            <div className="scroll-x">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Budget</th>
                    <th scope="col" className="num">
                      Before
                    </th>
                    <th scope="col" className="num">
                      After
                    </th>
                    <th scope="col" className="num">
                      Spent
                    </th>
                    <th scope="col">Never negative</th>
                    <th scope="col">Conserved</th>
                  </tr>
                </thead>
                <tbody>
                  {report.budgets.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <code>{b.id}</code>
                      </td>
                      <td className="num">{unitFmt(b.unit)(b.before)}</td>
                      <td className="num">{unitFmt(b.unit)(b.after)}</td>
                      <td className="num">{unitFmt(b.unit)(b.spent)}</td>
                      <td>
                        <Mark pass={b.neverNegative} />
                      </td>
                      <td>
                        <Mark pass={b.conserved} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Isolation() {
  const { api, session } = useDesk();
  const probe = useResource((s) => api.isolation(s), session?.token ?? '');
  if (probe.error) return <Failure error={probe.error} retry={probe.reload}>The isolation probe did not run.</Failure>;
  if (!probe.data) return <Loading>Trying to read other tenants with this desk’s own database user</Loading>;
  const p = probe.data;
  return (
    <div className="stack" style={{ gap: 28 }}>
      <p style={{ maxWidth: '44em', color: 'var(--ink-2)' }}>
        Your desk runs as its own FalkorDB user, allowed onto its own graph and nothing else. The probe logs in as that user
        and tries the rest. The refusals below are FalkorDB’s own words, and its ACL log keeps a record of each.
      </p>
      <div className="ok-note">
        <p>
          <code>{p.ownGraph.graph}</code>: {p.ownGraph.ok ? `readable, ${count(p.ownGraph.rows)} rows` : 'not readable'}
        </p>
      </div>
      <div className="scroll-x">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Attempt</th>
              <th scope="col">On</th>
              <th scope="col">FalkorDB answered</th>
            </tr>
          </thead>
          <tbody>
            {p.attempts.map((a) => (
              <tr key={a.command + a.graph}>
                <td>
                  <code>{a.command}</code>
                </td>
                <td>
                  <code>{a.graph}</code>
                </td>
                <td>{a.error ? <span className="noperm">{a.error}</span> : <span className="fail">allowed</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section>
        <h2 className="h3" style={{ marginBottom: 12 }}>
          ACL LOG
        </h2>
        <div className="scroll-x">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Reason</th>
                <th scope="col">Object</th>
                <th scope="col">User</th>
                <th scope="col" className="num">
                  Age
                </th>
              </tr>
            </thead>
            <tbody>
              {p.aclLog.map((l, i) => (
                <tr key={`${l.object}-${i}`}>
                  <td>{l.reason}</td>
                  <td>
                    <code>{l.object}</code>
                  </td>
                  <td>
                    <code>{l.username}</code>
                  </td>
                  <td className="num">{l.ageSeconds < 1 ? '< 1 s' : `${Math.round(l.ageSeconds)} s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Ledger() {
  const { api, session, version } = useDesk();
  const ledger = useResource((s) => api.ledger(s), `${session?.token}:${version}`);
  if (ledger.error) return <Failure error={ledger.error} retry={ledger.reload}>The ledger did not verify.</Failure>;
  if (!ledger.data) return <Loading>Re-hashing the chain and checking every decision against it</Loading>;
  const { verify: v, tail } = ledger.data;
  return (
    <div className="stack" style={{ gap: 28 }}>
      <div className={v.ok ? 'ok-note' : 'refusal'}>
        <p>
          {v.ok ? 'The chain verifies end to end.' : `The chain is broken at #${v.brokenAt}: ${v.reason}`} {count(v.length)}{' '}
          entries, head <code title={v.head}>{short(v.head, 16)}</code>.
        </p>
        {v.decisionsChecked != null ? (
          <p className="muted" style={{ fontSize: 14 }}>
            {count(v.decisionsChecked)} decisions compared field by field with what the ledger committed to:{' '}
            {v.mismatched?.length ?? 0} mismatched, {v.unrecorded?.length ?? 0} unrecorded, {v.vanished?.length ?? 0} vanished.
          </p>
        ) : null}
      </div>
      <div className="scroll-x">
        <table className="data">
          <thead>
            <tr>
              <th scope="col" className="num">
                Seq
              </th>
              <th scope="col">Kind</th>
              <th scope="col">Records</th>
              <th scope="col">Hash</th>
              <th scope="col">Previous</th>
              <th scope="col">At</th>
            </tr>
          </thead>
          <tbody>
            {tail.map((e) => (
              <tr key={e.seq}>
                <td className="num">#{e.seq}</td>
                <td>{e.kind}</td>
                <td>{e.refId.startsWith('dec-') ? <Link href={`/desk/decision/${e.refId}`}>{e.refId}</Link> : <code>{e.refId}</code>}</td>
                <td>
                  <code title={e.hash}>{short(e.hash, 12)}</code>
                </td>
                <td>
                  <code title={e.prev}>{short(e.prev, 12)}</code>
                </td>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                  {dateTime(e.at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Evaluation() {
  const evaluation = useResource((s) => publicApi.evaluation(s), 'eval');
  if (evaluation.error) return <Failure error={evaluation.error} retry={evaluation.reload}>The evaluation results did not load.</Failure>;
  if (!evaluation.data) return <Loading>Fetching the sealed evaluation</Loading>;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <p style={{ maxWidth: '44em', color: 'var(--ink-2)' }}>
        {evaluation.data.cases} cases across thirteen trap classes, written and sealed before any arm ran. Every arm saw the
        same requests against the same company.
      </p>
      <TableOfCases data={evaluation.data} />
    </div>
  );
}

function FlagBar({ flags, size }: { flags: Partial<Record<Flag, number>>; size: number }) {
  const order: Flag[] = ['green', 'yellow', 'red'];
  return (
    <span className="flag-bar" role="img" aria-label={order.map((f) => `${flags[f] ?? 0} ${FLAG_NAME[f]}`).join(', ')}>
      {order.map((f) =>
        flags[f] ? <span key={f} className={`fb-${f}`} style={{ flex: flags[f] }} title={`${flags[f]} of ${size}: ${FLAG_NAME[f]}`} /> : null,
      )}
    </span>
  );
}

function Algorithms() {
  const { api, session, version } = useDesk();
  const k = `${session?.token}:${version}`;
  const leading = useResource((s) => api.leading(s), k);
  const bottlenecks = useResource((s) => api.bottlenecks(s), k);
  const clusters = useResource((s) => api.clusters(s), k);
  const maxScore = Math.max(...(leading.data ?? []).map((l) => l.score), 0);
  const maxB = Math.max(...(bottlenecks.data ?? []).map((b) => b.score), 0);
  return (
    <div className="stack" style={{ gap: 40 }}>
      <section>
        <h2 className="h3">Leading cases</h2>
        <p className="muted" style={{ fontSize: 14, margin: '6px 0 14px' }}>
          PageRank over the citation graph: the precedents everything else leans on, with their live flag.
        </p>
        {leading.error ? <Failure error={leading.error} retry={leading.reload} /> : null}
        {!leading.data && !leading.error ? <Loading>Ranking precedent</Loading> : null}
        {leading.data ? (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Precedent</th>
                  <th scope="col">Policy</th>
                  <th scope="col" className="num">
                    Followers
                  </th>
                  <th scope="col">Rank</th>
                </tr>
              </thead>
              <tbody>
                {leading.data.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                        <Glyph signal={l.standing.flag} />
                        <Link href={`/desk/decision/${l.id}`}>
                          <i style={{ fontFamily: 'var(--serif)', fontSize: 16 }}>{l.account}</i>
                        </Link>
                      </span>
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        {l.id}, {fmt(l.policyId, l.value)}, {l.madeBy}
                      </span>
                    </td>
                    <td className="muted">{POLICY_NAME[l.policyId] ?? l.policyId}</td>
                    <td className="num">{l.followers}</td>
                    <td style={{ minWidth: 120 }}>
                      <span className="score-bar" style={{ width: `${maxScore ? (l.score / maxScore) * 100 : 0}px` }} title={l.score.toFixed(5)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <div className="two-col">
        <section>
          <h2 className="h3">Approval bottlenecks</h2>
          <p className="muted" style={{ fontSize: 14, margin: '6px 0 14px' }}>
            Betweenness over the reporting graph: the people most escalation paths pass through.
          </p>
          {bottlenecks.error ? <Failure error={bottlenecks.error} retry={bottlenecks.reload} /> : null}
          {!bottlenecks.data && !bottlenecks.error ? <Loading>Measuring the authority graph</Loading> : null}
          {bottlenecks.data ? (
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Centrality</th>
                  <th scope="col" className="num">
                    Waiting
                  </th>
                </tr>
              </thead>
              <tbody>
                {bottlenecks.data.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.name}
                      <br />
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        {b.title}
                      </span>
                    </td>
                    <td>
                      <span className="score-bar" style={{ width: `${maxB ? (b.score / maxB) * 100 : 0}px` }} /> {b.score}
                    </td>
                    <td className="num">{b.waiting}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>

        <section>
          <h2 className="h3">Exception clusters</h2>
          <p className="muted" style={{ fontSize: 14, margin: '6px 0 14px' }}>
            Label propagation over decisions and their reasons: families of exceptions, with how much of each is still good law.
          </p>
          {clusters.error ? <Failure error={clusters.error} retry={clusters.reload} /> : null}
          {!clusters.data && !clusters.error ? <Loading>Finding communities</Loading> : null}
          {clusters.data ? (
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Cluster</th>
                  <th scope="col" className="num">
                    Size
                  </th>
                  <th scope="col">Standing</th>
                </tr>
              </thead>
              <tbody>
                {clusters.data.map((c) => (
                  <tr key={c.communityId}>
                    <td>
                      {reason(c.reason)}
                      <br />
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        {POLICY_NAME[c.policyId] ?? c.policyId}, mean {fmt(c.policyId, c.meanValue)}
                        {c.ruleCandidate ? ', rule candidate' : ''}
                      </span>
                    </td>
                    <td className="num">{c.size}</td>
                    <td style={{ minWidth: 110, verticalAlign: 'middle' }}>
                      <FlagBar flags={c.flags} size={c.size} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <p className="plate-legend">
            <span>
              <Glyph signal="green" /> good law
            </span>
            <span>
              <Glyph signal="yellow" /> Overruling Risk
            </span>
            <span>
              <Glyph signal="red" /> not good law
            </span>
          </p>
        </section>
      </div>
    </div>
  );
}

export default function Proof() {
  const [tab, setTab] = useState<Tab>('race');
  useEffect(() => {
    const h = window.location.hash.slice(1) as Tab;
    if (TABS.some((t) => t.id === h)) setTab(h);
  }, []);
  const choose = (t: Tab) => {
    setTab(t);
    window.history.replaceState(null, '', `#${t}`);
  };
  return (
    <>
      <PageHead title="Proof">
        The claims the desk makes, checked while you watch: concurrency, tenant isolation, the hash chain, the sealed
        evaluation, and the graph algorithms that run inside FalkorDB.
      </PageHead>
      <div className="tabs" role="tablist" aria-label="Proof">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-controls={`panel-${t.id}`} className="tab" aria-selected={tab === t.id} onClick={() => choose(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'race' ? <Race /> : null}
        {tab === 'isolation' ? <Isolation /> : null}
        {tab === 'ledger' ? <Ledger /> : null}
        {tab === 'evaluation' ? <Evaluation /> : null}
        {tab === 'algorithms' ? <Algorithms /> : null}
      </div>
    </>
  );
}
