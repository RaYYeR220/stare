'use client';

import { useState } from 'react';
import { Failure, Loading, PageHead } from '@/components/bits';
import { ActorSelect } from '@/components/desk/ActorSelect';
import { ApiError } from '@/lib/api';
import { useDesk } from '@/lib/desk';
import { AGENT_NAME, time } from '@/lib/format';
import type { McpToken } from '@/lib/types';
import { useResource } from '@/lib/useResource';

function Copy({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-line">
      <code title={text}>{text}</code>
      <button
        type="button"
        className="btn btn-quiet btn-small"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

function config(t: McpToken): string {
  return JSON.stringify(
    { mcpServers: { stare: { type: 'http', url: t.url, headers: { Authorization: `Bearer ${t.token}` } } } },
    null,
    2,
  );
}

function Auditor() {
  const { api, session } = useDesk();
  const auditor = useResource((s) => api.auditor(s), session?.token ?? '');
  if (auditor.error instanceof ApiError && auditor.error.status === 404) return null;
  if (auditor.error) return <Failure error={auditor.error} retry={auditor.reload}>The auditor details did not load.</Failure>;
  if (!auditor.data) return <Loading>Looking for the read-only auditor</Loading>;
  const a = auditor.data;
  return (
    <section className="panel" aria-labelledby="auditor-title">
      <h2 id="auditor-title" className="h3">
        The read-only auditor
      </h2>
      <p style={{ color: 'var(--ink-2)', fontSize: 14.5 }}>
        Raw Cypher through FalkorDB’s own MCP server: reads work, writes and other tenants get NOPERM from the database.
      </p>
      <div className="field">
        <span className="field-label">MCP URL</span>
        <Copy text={a.url} label="auditor URL" />
      </div>
      <div className="field">
        <span className="field-label">
          Key, sent as <code>Authorization: Bearer &lt;key&gt;</code>
        </span>
        <Copy text={a.key} label="auditor key" />
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Database user <code>{a.user}</code> on <code>{a.graph}</code>, allowed: {a.allowed.join(', ')}.
      </p>
    </section>
  );
}

export default function Connect() {
  const { api, session, personName } = useDesk();
  const [principal, setPrincipal] = useState('a-support');
  const [pending, setPending] = useState(false);
  const [token, setToken] = useState<McpToken | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const issue = async () => {
    setPending(true);
    setError(null);
    try {
      setToken(await api.mcpToken(principal));
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };

  const who = token ? (AGENT_NAME[token.principal.id] ?? personName(token.principal.id)) : null;

  return (
    <>
      <PageHead title="Connect">
        Point any MCP client at this desk. The server speaks MCP 2026-07-28 over stateless HTTP; when a tool needs a
        confirmation (approving, ratifying, adopting a policy, erasing someone) it comes back as an input request over several
        round trips, and your client answers it.
      </PageHead>

      <div className="connect-grid">
        <section className="stack" aria-label="Desk token">
          <form
            className="panel panel-gold"
            onSubmit={(e) => {
              e.preventDefault();
              void issue();
            }}
          >
            <ActorSelect id="mcp-principal" value={principal} onChange={setPrincipal} label="The client acts as" />
            <p className="muted" style={{ fontSize: 13.5 }}>
              A token is bound to one principal in this desk. It can do exactly what that agent or person may do here, and it
              closes with the desk{session ? ` at ${time(session.expiresAt)}` : ''}.
            </p>
            <div className="row">
              <button type="submit" className="btn" disabled={pending}>
                {pending ? 'Issuing' : 'Issue a token'}
              </button>
            </div>
          </form>
          {error ? <Failure error={error}>No token was issued.</Failure> : null}
          {token ? (
            <div className="stack" style={{ gap: 14 }}>
              <div className="field">
                <span className="field-label">MCP URL</span>
                <Copy text={token.url} label="MCP URL" />
              </div>
              <div className="field">
                <span className="field-label">Bearer token for {who}</span>
                <Copy text={token.token} label="token" />
              </div>
              <div className="field">
                <span className="field-label">Client configuration</span>
                <pre className="pre">{config(token)}</pre>
              </div>
            </div>
          ) : null}
        </section>

        <div className="stack" style={{ gap: 24 }}>
          <section className="panel" aria-labelledby="tools-title">
            <h2 id="tools-title" className="h3">
              What the client gets
            </h2>
            <p style={{ color: 'var(--ink-2)', fontSize: 14.5 }}>
              <code>file_exception</code>, <code>find_precedent</code>, <code>check_standing</code>, <code>explain_decision</code>,{' '}
              <code>trace_source</code>, <code>who_can_approve</code>, <code>approve_escalation</code>, <code>ratify_rule</code>,{' '}
              <code>policy_impact</code>, <code>adopt_policy</code>, <code>erase_subject</code>, <code>recall</code>,{' '}
              <code>remember</code>, <code>handoff</code>, <code>verify_ledger</code> and the graph algorithms. Every call is
              checked against the principal’s authority at the moment it runs.
            </p>
          </section>
          <Auditor />
        </div>
      </div>
    </>
  );
}
