'use client';

import { useState } from 'react';
import { Failure, Loading, PageHead } from '@/components/bits';
import { useDesk } from '@/lib/desk';
import { POLICY_NAME, value as fmt } from '@/lib/format';
import type { Person } from '@/lib/types';

function Depart({ p }: { p: Person }) {
  const { api, touch } = useDesk();
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState<number | null>(null);

  if (done !== null) return <span className="muted">Departed, ledger #{done}</span>;
  if (!p.active) return <span className="muted">Departed</span>;
  if (!confirm) {
    return (
      <button type="button" className="btn btn-quiet btn-small" onClick={() => setConfirm(true)}>
        Depart
      </button>
    );
  }
  return (
    <span className="row" style={{ gap: 8 }}>
      <button
        type="button"
        className="btn btn-danger btn-small"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const r = await api.depart(p.id);
            setDone(r.ledgerSeq ?? 0);
            touch();
          } catch (e) {
            setError(e as Error);
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Recording' : `Confirm ${p.name.split(' ')[0]} leaves`}
      </button>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => setConfirm(false)} disabled={pending}>
        Keep
      </button>
      {error ? <span className="fail" style={{ fontSize: 13 }}>{error.message}</span> : null}
    </span>
  );
}

export default function People() {
  const { people, peopleResource } = useDesk();
  const loading = !people.length && peopleResource.loading;
  const [filter, setFilter] = useState<'authority' | 'all'>('authority');
  const rows = [...people]
    .filter((p) => filter === 'all' || p.authority.length || !p.active)
    .sort((a, b) => Math.max(0, ...b.authority.map((x) => x.cap)) - Math.max(0, ...a.authority.map((x) => x.cap)) || a.name.localeCompare(b.name));

  return (
    <>
      <PageHead title="People" aside={people.length ? `${people.length} people, ${people.filter((p) => !p.active).length} departed` : undefined}>
        Roles and approval authority per policy, as the authority graph holds them today. When someone leaves, their roles,
        ownerships, delegations and reporting lines close at that moment; the decisions they made while they held authority
        stay good law.
      </PageHead>

      <div className="tabs" role="tablist" aria-label="Who to show">
        <button type="button" role="tab" className="tab" aria-selected={filter === 'authority'} onClick={() => setFilter('authority')}>
          With approval authority
        </button>
        <button type="button" role="tab" className="tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')}>
          Everyone
        </button>
      </div>

      {loading ? <Loading>Reading the people graph</Loading> : null}
      {peopleResource.error ? (
        <Failure error={peopleResource.error} retry={peopleResource.reload}>
          The people graph did not load.
        </Failure>
      ) : null}
      {people.length ? (
        <div className="scroll-x">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Roles</th>
                {(['refunds', 'discounts', 'payment_terms'] as const).map((pid) => (
                  <th key={pid} scope="col" className="num">
                    {POLICY_NAME[pid].replace(' policy', '')}
                  </th>
                ))}
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.6 }}>
                  <td>
                    <span style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>{p.name}</span>
                    <br />
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      {p.title}, <code>{p.id}</code>
                    </span>
                  </td>
                  <td className="muted">{p.roles.join(', ') || 'none'}</td>
                  {(['refunds', 'discounts', 'payment_terms'] as const).map((pid) => {
                    const a = p.authority.find((x) => x.policy === pid);
                    return (
                      <td key={pid} className="num">
                        {a ? fmt(pid, a.cap) : <span className="muted">none</span>}
                      </td>
                    );
                  })}
                  <td style={{ textAlign: 'right' }}>
                    <Depart p={p} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
