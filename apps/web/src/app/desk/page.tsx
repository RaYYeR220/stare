'use client';

import { useEffect, useRef, useState } from 'react';
import { Empty, Failure, Loading, PageHead } from '@/components/bits';
import { ActorSelect } from '@/components/desk/ActorSelect';
import { SlipOpinion } from '@/components/desk/Opinion';
import { Transcript } from '@/components/desk/Transcript';
import { Glyph } from '@/components/Glyph';
import { useDesk } from '@/lib/desk';
import { AGENT_NAME, time } from '@/lib/format';
import type { AgentId, DecideResponse, Incoming, Transcript as T } from '@/lib/types';
import { useResource } from '@/lib/useResource';

type Result = { kind: 'verdict'; data: DecideResponse; actor: string } | { kind: 'transcript'; data: T; channel: string };

interface Job {
  kind: 'decide' | 'handle';
  key: string;
  started: number;
}

const CHANNEL_NAME: Record<string, string> = {
  '#support-escalations': 'Support escalations',
  '#deal-desk': 'Deal desk',
  '#billing-ops': 'Billing operations',
};

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))} s</>;
}

export default function AdvanceSheets() {
  const { api, personName, touch, session } = useDesk();
  const incoming = useResource((s) => api.incoming(s), session?.token ?? '');
  const [text, setText] = useState('');
  const [actor, setActor] = useState('a-support');
  const [job, setJob] = useState<Job | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [reading, setReading] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);

  /** Bring the result into view: the page on narrow screens, the reading pane's own scroll on wide ones. */
  const reveal = () => {
    setReading(false);
    const el = resultRef.current;
    if (!el) return;
    el.scrollTop = 0;
    if (el.getBoundingClientRect().top < 0 || window.matchMedia('(max-width: 1100px)').matches) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const decide = async (key: string, body: string, who: string) => {
    setActive(key);
    setJob({ kind: 'decide', key, started: Date.now() });
    setError(null);
    reveal();
    try {
      const data = await api.decide(body, who);
      setResult({ kind: 'verdict', data, actor: who });
      touch();
    } catch (e) {
      setError(e as Error);
    } finally {
      setJob(null);
    }
  };

  const hand = async (key: string, body: string, channel: string, agent?: string) => {
    setActive(key);
    setJob({ kind: 'handle', key, started: Date.now() });
    setError(null);
    reveal();
    try {
      const data = await api.handle(body, channel, agent);
      setResult({ kind: 'transcript', data, channel });
      touch();
    } catch (e) {
      setError(e as Error);
    } finally {
      setJob(null);
    }
  };

  const groups = new Map<string, Incoming[]>();
  for (const r of incoming.data ?? []) groups.set(r.channel, [...(groups.get(r.channel) ?? []), r]);
  const busy = job !== null;
  const actorIsAgent = actor.startsWith('a-');

  return (
    <>
      <PageHead title="Advance sheets" aside={incoming.data ? `${incoming.data.length} requests waiting today` : undefined}>
        Today’s requests from Northwind Cloud’s channels. Decide one here and read the opinion, or hand it to its agent and
        watch it work through the desk’s tools.
      </PageHead>

      <div className={`sheets-grid${reading ? ' reading' : ''}`}>
        <div className="sheets-list">
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void decide('composer', text.trim(), actor);
            }}
          >
            <label className="field" htmlFor="request-text">
              <span className="field-label">File a request of your own</span>
              <textarea
                id="request-text"
                className="textarea"
                value={text}
                maxLength={2000}
                placeholder="Basalt Cloud needs 32% off list for the renewal, competitor pressure."
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <ActorSelect id="request-actor" value={actor} onChange={setActor} />
            <div className="composer-actions">
              <button type="submit" className="btn" disabled={busy || !text.trim()}>
                Decide
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={busy || !text.trim() || !actorIsAgent}
                title={actorIsAgent ? undefined : 'Only an agent can be handed a request'}
                onClick={() => void hand('composer', text.trim(), 'desk', actor as AgentId)}
              >
                Hand to the agent
              </button>
            </div>
          </form>

          {incoming.error ? <Failure error={incoming.error} retry={incoming.reload}>Today’s requests did not load.</Failure> : null}
          {!incoming.data && incoming.loading ? <Loading>Fetching today’s requests</Loading> : null}
          {incoming.data && !incoming.data.length ? <Empty>No requests are waiting. File one above.</Empty> : null}

          {[...groups.entries()].map(([channel, rows]) => (
            <section key={channel} aria-label={CHANNEL_NAME[channel] ?? channel}>
              <h2 className="request-group kicker-sc">{CHANNEL_NAME[channel] ?? channel}</h2>
              <ul className="requests">
                {rows.map((r) => (
                  <li key={r.id} className="request" data-active={active === r.id}>
                    <div className="request-meta">
                      <span>
                        <code>{r.channel}</code>, from {personName(r.from)}
                      </span>
                      <span>{time(r.at)}</span>
                    </div>
                    <p className="request-text">{r.text}</p>
                    <div className="row">
                      <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void decide(r.id, r.text, r.agent)}>
                        {job?.key === r.id && job.kind === 'decide' ? 'Deciding' : 'Decide'}
                      </button>
                      <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void hand(r.id, r.text, r.channel)}>
                        {job?.key === r.id && job.kind === 'handle' ? 'The agent is working' : 'Hand to the agent'}
                      </button>
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        {AGENT_NAME[r.agent]}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="result" ref={resultRef} aria-live="polite">
          {reading ? (
            <div className="reading-bar">
              <span>Structure on and structure off, side by side.</span>
              <button type="button" className="btn btn-quiet btn-small" onClick={() => setReading(false)}>
                Show the requests again
              </button>
            </div>
          ) : null}
          {job ? (
            <div style={{ opacity: 1 }}>
              <Loading>
                {job.kind === 'decide'
                  ? 'Reading the request, then checking every covering precedent’s standing in FalkorDB'
                  : 'The agent is recalling, filing and remembering over MCP'}
                , <Elapsed since={job.started} />
              </Loading>
            </div>
          ) : null}
          {error ? <Failure error={error}>The desk could not finish that request.</Failure> : null}
          <div style={{ opacity: job ? 0.45 : 1, transition: 'opacity .3s' }}>
            {result?.kind === 'verdict' ? (
              <SlipOpinion
                key={`${result.data.verdict.caseId}-${result.data.verdict.at}`}
                verdict={result.data.verdict}
                ablation={result.data.ablation}
                actor={result.actor}
                onStrike={(on) => {
                  setReading(on);
                  if (on) window.scrollTo({ top: Math.max(0, (resultRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY - 16), behavior: 'smooth' });
                }}
              />
            ) : result?.kind === 'transcript' ? (
              <Transcript t={result.data} channel={result.channel} />
            ) : !job && !error ? (
              <div className="result-empty">
                <p>Choose a request, or file your own. The opinion is set here, with every precedent it stands on.</p>
                <ul className="legend">
                  <li>
                    <Glyph signal="green" /> <b>Good law</b> the agent may stand on it
                  </li>
                  <li>
                    <Glyph signal="yellow" /> <b>Overruling Risk</b> rests on a precedent that is no longer good law
                  </li>
                  <li>
                    <Glyph signal="red" /> <b>Not good law</b> overturned, no authority, superseded or conflicted
                  </li>
                  <li>
                    <Glyph signal="pending" /> <b>Pending</b> escalated, waiting on a person
                  </li>
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
