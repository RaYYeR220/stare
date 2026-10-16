'use client';

import { useState } from 'react';
import { Empty, Failure, Loading, PageHead, Stamp } from '@/components/bits';
import { useDesk } from '@/lib/desk';
import { count, dateTime, plural, short } from '@/lib/format';
import type { Certificate, Check, Contact, ErasureResponse } from '@/lib/types';
import { useResource } from '@/lib/useResource';

function Checks({ checks }: { checks: Check[] }) {
  return (
    <ol className="cert-checks">
      {checks.map((c) => (
        <li key={c.id}>
          <code>{c.id}</code>
          <span className="cert-name">{c.name}</span>
          <span className={`verdict-mark ${c.pass ? 'pass' : 'fail'}`}>{c.pass ? 'Pass' : 'Fail'}</span>
          <span className="cert-check-detail">{c.detail}</span>
        </li>
      ))}
    </ol>
  );
}

/** Line lengths of a blanked page, so the bars read as set text rather than a chart. */
const LINES = [94, 88, 97, 71, 91, 96, 84, 62, 93, 89, 97, 78, 90, 58];

function ExpungedVolume({ subject, cert }: { subject: Contact; cert: Certificate }) {
  const n = cert.counts;
  const bars = Math.min(14, Math.max(4, n.messagesErased));
  return (
    <div className="expunged">
      <div className="expunged-spine" aria-hidden="true">
        <span>Expunged</span>
      </div>
      <div className="expunged-pages">
        <p className="kicker-sc">The record of {subject.account}, as it now reads</p>
        <div className="expunged-lines" aria-label={`${n.messagesErased} messages blanked`}>
          {Array.from({ length: bars }, (_, i) => (
            <span key={`b${i}`} className="blank-bar" style={{ width: `${LINES[i % LINES.length]}%` }} />
          ))}
          <p style={{ marginTop: 12 }}>
            {count(n.messagesErased)} messages and {count(n.sourcesErased)} sources blanked, {count(n.recordsRedacted)} records
            redacted, {count(n.vectorsRewritten)} vectors rewritten, {count(n.decisionsRegrounded)} decisions re-grounded on what
            remains. {plural(n.factsDeleted.length, 'fact')} deleted;{' '}
            {n.factsRetained.length
              ? `${count(n.factsRetained.length)} kept because other sources still support them.`
              : 'none kept.'}
          </p>
        </div>
        <section className="certificate" aria-label="Certificate of erasure">
          <h3>Certificate of Erasure</h3>
          <p className="cert-no">
            No. {cert.erasureId}, {dateTime(cert.at)}
          </p>
          <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
            <Stamp outcome={cert.verdict === 'ERASED' ? 'erased' : 'refused'} label={cert.verdict === 'ERASED' ? 'Erased' : 'Refused'} />
          </div>
          <Checks checks={cert.checks} />
          <div className="cert-counts">
            <span>
              <b>{count(n.messagesErased)}</b>messages
            </span>
            <span>
              <b>{count(n.vectorsRewritten)}</b>vectors
            </span>
            <span>
              <b>{count(n.decisionsRegrounded)}</b>decisions re-grounded
            </span>
          </div>
          <p className="cert-hash">
            Subject commitment <code>{cert.subjectCommitment}</code>
          </p>
          <p className="cert-hash">
            Ledger {cert.ledger.ok ? 'verifies' : 'does not verify'}, {count(cert.ledger.length)} entries, head{' '}
            <code>{short(cert.ledger.head, 16)}</code>
          </p>
          <p className="cert-hash">
            Certificate hash <code>{cert.certificateHash}</code>
          </p>
        </section>
      </div>
    </div>
  );
}

function Control({ control }: { control: ErasureResponse['control'] }) {
  if (!control) {
    return (
      <div className="control">
        <p className="muted">The naive-delete control could not be run on a copy this time; the certificate stands on its own.</p>
      </div>
    );
  }
  const failed = control.checks.filter((c) => !c.pass).length;
  return (
    <div className="control">
      <p className="kicker-sc" style={{ color: 'var(--ink-3)' }}>
        The control
      </p>
      <h3 className="h3" style={{ marginTop: 4 }}>
        A naive delete, on a copy
      </h3>
      <p className="muted" style={{ fontSize: 14, margin: '8px 0 14px' }}>
        <code>DETACH DELETE</code> the contact node and nothing else, then the same four checks, judged by the same code.{' '}
        {failed ? `${failed} of 4 fail.` : 'All four pass.'}
      </p>
      <Stamp outcome={control.verdict === 'ERASED' ? 'erased' : 'refused'} label={control.verdict === 'ERASED' ? 'Erased' : 'Refused'} />
      <Checks checks={control.checks} />
    </div>
  );
}

export default function Erasure() {
  const { api, version, session, touch } = useDesk();
  const contacts = useResource((s) => api.contacts(s), `${session?.token}:${version}`);
  const issued = useResource((s) => api.erasures(s), `${session?.token}:${version}`);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [result, setResult] = useState<{ subject: Contact; data: ErasureResponse } | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const erase = async (c: Contact) => {
    setPending(c.id);
    setError(null);
    try {
      const data = await api.erase(c.id);
      setResult({ subject: c, data });
      setConfirm(null);
      touch();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <PageHead title="Erasure">
        A customer contact asks to be forgotten. The desk erases them from messages, facts, vectors and decisions, keeps
        precedent standing on what remains, and proves it with four checks. Beside it, the same checks on a naive delete.
      </PageHead>

      {pending ? <Loading>Erasing on your graph, and running the naive delete on a copy for comparison</Loading> : null}
      {error ? <Failure error={error}>The erasure did not complete.</Failure> : null}

      {result ? (
        <div className="erasure-grid">
          <ExpungedVolume subject={result.subject} cert={result.data.certificate} />
          <Control control={result.data.control} />
        </div>
      ) : null}

      <section style={{ marginTop: 48 }} aria-labelledby="subjects-title">
        <h2 id="subjects-title" className="h3">
          Data subjects
        </h2>
        <p className="muted" style={{ fontSize: 14, margin: '6px 0 16px' }}>
          Customer contacts, with how many spans of text in the graph mention them.
        </p>
        {contacts.error ? <Failure error={contacts.error} retry={contacts.reload}>The contacts did not load.</Failure> : null}
        {!contacts.data && contacts.loading ? <Loading>Reading contacts</Loading> : null}
        {contacts.data && !contacts.data.length ? <Empty>Every contact in this desk has been erased.</Empty> : null}
        {contacts.data?.length ? (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Contact</th>
                  <th scope="col">Account</th>
                  <th scope="col" className="num">
                    Mentions
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {contacts.data.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>{c.name}</span>
                      <br />
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        {c.title}
                      </span>
                    </td>
                    <td>{c.account}</td>
                    <td className="num">{c.mentions}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {confirm === c.id ? (
                        <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                          <button type="button" className="btn btn-danger btn-small" disabled={pending !== null} onClick={() => void erase(c)}>
                            {pending === c.id ? 'Erasing' : `Erase ${c.name.split(' ')[0]}`}
                          </button>
                          <button type="button" className="btn btn-quiet btn-small" disabled={pending !== null} onClick={() => setConfirm(null)}>
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button type="button" className="btn btn-quiet btn-small" disabled={pending !== null} onClick={() => setConfirm(c.id)}>
                          Erase
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {issued.data?.length ? (
        <section style={{ marginTop: 48 }} aria-labelledby="issued-title">
          <h2 id="issued-title" className="h3">
            Certificates issued on this desk
          </h2>
          <ul className="ruled-list" style={{ marginTop: 12 }}>
            {issued.data.map((e) => {
              let cert: Certificate | null = null;
              try {
                cert = JSON.parse(e.certificate) as Certificate;
              } catch {
                cert = null;
              }
              return (
                <li key={e.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>
                    <code>{e.id}</code>, {dateTime(e.at)}
                  </span>
                  <span className="muted" style={{ fontSize: 13 }}>
                    {cert ? `${cert.verdict}, ${cert.checks.filter((c) => c.pass).length} of 4 checks, ` : ''}
                    <code>{short(cert?.certificateHash, 16)}</code>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}
