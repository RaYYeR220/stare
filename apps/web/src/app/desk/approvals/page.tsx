'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Empty, Failure, Loading, PageHead, Stamp } from '@/components/bits';
import { PersonSelect } from '@/components/desk/ActorSelect';
import { Signal } from '@/components/Glyph';
import { useDesk } from '@/lib/desk';
import { CODE_GLOSS, dateTime, reason, sentence, value as fmt } from '@/lib/format';
import type { InboxItem, ResolveResult } from '@/lib/types';
import { useResource } from '@/lib/useResource';

type Choice = 'approve' | 'partial' | 'reject';

function Ruling({ e, onRecorded }: { e: InboxItem; onRecorded: (r: ResolveResult) => void }) {
  const { api } = useDesk();
  const [personId, setPersonId] = useState(e.routedToId ?? 'p-priya');
  const [choice, setChoice] = useState<Choice>('approve');
  const [amount, setAmount] = useState(String(Math.round(e.value / 2)));
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const r = await api.resolve(e.id, {
        personId,
        approve: choice !== 'reject',
        value: choice === 'partial' ? Number(amount) : undefined,
        note: note.trim() || undefined,
      });
      setResult(r);
      if (r.ok) onRecorded(r);
    } catch (err) {
      setError(err as Error);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="ruling"
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
    >
      <PersonSelect id={`p-${e.id}`} value={personId} onChange={setPersonId} label="Rule as" policy={e.policyId} />
      <fieldset style={{ border: 0 }}>
        <legend className="field-label" style={{ marginBottom: 6 }}>
          Ruling
        </legend>
        <div className="choice">
          {(['approve', 'partial', 'reject'] as Choice[]).map((c) => (
            <label key={c}>
              <input type="radio" name={`choice-${e.id}`} value={c} checked={choice === c} onChange={() => setChoice(c)} />
              {c === 'approve' ? `Approve ${fmt(e.policyId, e.value)}` : c === 'partial' ? 'Approve part' : 'Reject'}
            </label>
          ))}
        </div>
      </fieldset>
      {choice === 'partial' ? (
        <label className="field" htmlFor={`v-${e.id}`}>
          <span className="field-label">Amount to approve ({e.policyId === 'refunds' ? 'dollars' : e.policyId === 'discounts' ? 'percent off list' : 'days'})</span>
          <input id={`v-${e.id}`} className="input" type="number" min={0} value={amount} onChange={(ev) => setAmount(ev.target.value)} />
        </label>
      ) : null}
      <label className="field" htmlFor={`n-${e.id}`}>
        <span className="field-label">Note for the record (optional)</span>
        <input id={`n-${e.id}`} className="input" value={note} maxLength={500} onChange={(ev) => setNote(ev.target.value)} />
      </label>
      <div className="row">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Recording the ruling' : 'Record the ruling'}
        </button>
      </div>
      {error ? <Failure error={error}>The ruling was not recorded.</Failure> : null}
      {result && !result.ok && result.refusal ? (
        <div className="refusal" role="alert">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <Stamp outcome="refused" small />
            <span className="refusal-code">{result.refusal.code}</span>
          </div>
          <p className="refusal-text">{result.refusal.detail}</p>
          <p className="muted" style={{ fontSize: 13.5 }}>
            {CODE_GLOSS[result.refusal.code] ? `${sentence(CODE_GLOSS[result.refusal.code]!)}. ` : ''}The desk will not record a ruling the
            graph does not authorize, whoever asks.
          </p>
        </div>
      ) : null}
    </form>
  );
}

function Recorded({ e, r }: { e: InboxItem; r: ResolveResult }) {
  return (
    <article className="escalation">
      <div>
        <h2 className="escalation-title">
          <i>{e.account}</i>, {fmt(e.policyId, e.value)} for {reason(e.reason)}
        </h2>
        {e.text ? <p className="escalation-text">“{e.text}”</p> : null}
      </div>
      <div className="ok-note" role="status">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Stamp outcome={r.outcome === 'approved' ? 'approved' : 'denied'} small />
          <span className="muted">{r.ledgerSeq != null ? `ledger #${r.ledgerSeq}` : ''}</span>
        </div>
        <p>
          {r.outcome === 'approved' ? `Approved ${fmt(e.policyId, r.value)}` : 'Rejected'} by {r.approver?.name ?? 'the approver'}
          {r.approver ? `, whose authority runs to ${fmt(e.policyId, r.approver.cap)}` : ''}. The ruling is now precedent:{' '}
          {r.decisionId ? <Link href={`/desk/decision/${r.decisionId}`}>{r.decisionId}</Link> : 'recorded'}.
        </p>
        {r.citations.length ? <p className="muted">Cites {r.citations.join(', ')}.</p> : null}
        {r.proposedRules.length ? (
          <p>
            It completed a pattern: <Link href="/desk/rules">{r.proposedRules.join(', ')}</Link> proposed as a standing rule.
          </p>
        ) : null}
      </div>
    </article>
  );
}

export default function Approvals() {
  const { api, personName, version, session, touch } = useDesk();
  const inbox = useResource((s) => api.inbox(s), `${session?.token}:${version}`);
  const [recorded, setRecorded] = useState<{ e: InboxItem; r: ResolveResult }[]>([]);
  const settled = new Set(recorded.map((x) => x.e.id));
  const open = (inbox.data ?? []).filter((e) => !settled.has(e.id));

  return (
    <>
      <PageHead title="Approvals" aside={inbox.data ? `${open.length} open` : undefined}>
        Escalations waiting on a person, routed by the shortest path through the reporting graph to someone whose authority
        covers the amount. Rule as anyone; the desk checks their authority, tenure and independence before it records a
        word, and says so when it refuses.
      </PageHead>
      {inbox.error ? <Failure error={inbox.error} retry={inbox.reload}>The inbox did not load.</Failure> : null}
      {!inbox.data && inbox.loading ? <Loading>Reading open escalations</Loading> : null}
      {recorded.map(({ e, r }) => (
        <Recorded key={e.id} e={e} r={r} />
      ))}
      {inbox.data && !open.length ? (
        <Empty>
          Nothing is waiting on a person. Escalate one from the <Link href="/desk">advance sheets</Link>.
        </Empty>
      ) : null}
      <div style={{ opacity: inbox.loading && inbox.data ? 0.6 : 1 }}>
        {open.map((e) => (
          <article key={e.id} className="escalation">
            <div>
              <Signal signal="pending">
                Waiting on {e.routedTo ?? 'nobody'}
                {e.why ? `, ${CODE_GLOSS[e.why] ?? e.why}` : ''}
              </Signal>
              <h2 className="escalation-title" style={{ marginTop: 10 }}>
                <i>{e.account}</i>, {fmt(e.policyId, e.value)} for {reason(e.reason)}
              </h2>
              {e.text ? <p className="escalation-text">“{e.text}”</p> : null}
              <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                {e.id}, case {e.caseId}, {dateTime(e.at)}
                {e.pathIds.length ? `. Route: ${e.pathIds.map((p) => personName(p)).join(', then ')}` : ''}
                {e.why ? (
                  <>
                    {' '}
                    <code>{e.why}</code>
                  </>
                ) : null}
              </p>
            </div>
            <Ruling
              e={e}
              onRecorded={(r) => {
                setRecorded((xs) => [{ e, r }, ...xs]);
                touch();
              }}
            />
          </article>
        ))}
      </div>
    </>
  );
}
