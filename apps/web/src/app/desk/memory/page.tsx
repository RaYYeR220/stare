'use client';

import { useState } from 'react';
import { Empty, Failure, Loading, PageHead } from '@/components/bits';
import { useDesk } from '@/lib/desk';
import { AGENT_NAME, date, dateTime, POLICY_NAME, value as fmt } from '@/lib/format';
import { useResource } from '@/lib/useResource';

const VIA: Record<string, string> = { vector: 'vector', graph: 'graph', both: 'vector and graph' };

export default function Memory() {
  const { api, overview, session, version } = useDesk();
  const [q, setQ] = useState('refund for an outage');
  const [account, setAccount] = useState('Acme Logistics');
  const [query, setQuery] = useState({ q: 'refund for an outage', account: 'Acme Logistics' });
  const items = useResource((s) => api.memory(query.q, query.account, s), `${session?.token}:${version}:${query.q}:${query.account}`);

  return (
    <>
      <PageHead title="Memory">
        What the agents remember between requests: episodes they wrote after acting and facts drawn from the record. Recall
        searches by vector, then walks the graph from the account, and says which way each memory was found.
      </PageHead>

      <form
        className="memory-form"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ q: q.trim() || 'recent requests', account: account.trim() });
        }}
      >
        <label className="field" htmlFor="mem-q">
          <span className="field-label">Recall</span>
          <input id="mem-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field" htmlFor="mem-account">
          <span className="field-label">About the account (optional)</span>
          <input id="mem-account" className="input" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Acme Logistics" />
        </label>
        <button type="submit" className="btn">
          Recall
        </button>
      </form>

      <div className="two-col" style={{ marginTop: 32 }}>
        <section aria-label="Recalled memories">
          {items.error ? <Failure error={items.error} retry={items.reload}>Recall failed.</Failure> : null}
          {!items.data && items.loading ? <Loading>Recalling</Loading> : null}
          {items.data && !items.data.length ? <Empty>Nothing comes to mind for that. Try an account name.</Empty> : null}
          {items.data?.length ? (
            <ul className="ruled-list" style={{ opacity: items.loading ? 0.6 : 1 }}>
              {items.data.map((m) => (
                <li key={m.id}>
                  <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                    <span className="muted">
                      {m.kind === 'episode' ? `Episode${m.agent ? `, ${AGENT_NAME[m.agent] ?? m.agent}` : ''}` : 'Fact'}, {date(m.at)}
                    </span>
                    <span className="row" style={{ gap: 8 }}>
                      {m.similarity != null ? <span className="muted">similarity {m.similarity.toFixed(2)}</span> : null}
                      <span className={`via${m.via === 'both' ? ' via-both' : ''}`}>{VIA[m.via]}</span>
                    </span>
                  </div>
                  <p style={{ fontFamily: 'var(--serif)', fontSize: 18, lineHeight: 1.45, marginTop: 6 }}>{m.text}</p>
                  {m.sources?.length ? (
                    <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                      From {m.sources.join('; ')}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section aria-labelledby="agents-title">
          <h2 id="agents-title" className="h3">
            The agents
          </h2>
          {!overview.data ? <Loading>Reading the agents</Loading> : null}
          {overview.data?.agents.map((a) => (
            <article key={a.id} className="agent-card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'var(--serif)', fontSize: 20 }}>{a.name}</span>
                <code className="muted">{a.id}</code>
              </div>
              <p className="muted" style={{ fontSize: 13.5 }}>
                {POLICY_NAME[a.policyId] ?? a.policyId}
              </p>
              <ul style={{ listStyle: 'none', marginTop: 10, fontSize: 14 }}>
                {a.delegations.filter((d) => d.person).length ? (
                  a.delegations
                    .filter((d) => d.person)
                    .map((d) => (
                      <li key={`${d.personId}-${d.policyId}`}>
                        Delegated by {d.person}, up to {fmt(d.policyId ?? a.policyId, d.cap)}
                      </li>
                    ))
                ) : (
                  <li className="muted">No live delegation: everything it files escalates.</li>
                )}
              </ul>
              {a.lastEpisode ? (
                <p style={{ marginTop: 10, fontSize: 14, color: 'var(--ink-2)' }}>
                  Last episode{a.lastAt ? `, ${dateTime(a.lastAt)}` : ''}: <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic' }}>{a.lastEpisode}</span>
                </p>
              ) : null}
            </article>
          ))}
        </section>
      </div>
    </>
  );
}
