import Link from 'next/link';
import { Stamp } from '@/components/bits';
import { AGENT_NAME } from '@/lib/format';
import type { Outcome, Step, Transcript as T } from '@/lib/types';

interface FiledResult {
  outcome?: Outcome;
  decisionId?: string | null;
  escalationId?: string | null;
  ledgerSeq?: number | null;
  refusal?: { code: string; detail: string } | null;
  route?: { name: string } | null;
}

function args(a: Record<string, unknown> | undefined): string {
  if (!a) return '';
  return Object.entries(a)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `“${v}”` : JSON.stringify(v)}`)
    .join('   ');
}

function StepRow({ s }: { s: Step }) {
  if (s.kind !== 'tool') {
    return s.kind === 'note' ? (
      <li className="step">
        <p className="muted">{s.text}</p>
      </li>
    ) : null;
  }
  const filed = s.tool === 'file_exception' && s.structured && typeof s.structured === 'object' ? (s.structured as FiledResult) : null;
  const text = s.result ?? '';
  return (
    <li className="step">
      <div>
        <div className="step-call">
          <code>{s.tool}</code>
          {s.ms != null ? <span className="muted">{s.ms} ms</span> : null}
        </div>
        {s.args && Object.keys(s.args).length ? <p className="step-args">{args(s.args)}</p> : null}
        <p className={`step-result${text.length > 600 ? ' long' : ''}`}>{text}</p>
        {filed?.outcome ? (
          <div className="step-outcome">
            <Stamp outcome={filed.outcome} small />
            {filed.refusal ? (
              <span className="muted">
                <code>{filed.refusal.code}</code> {filed.refusal.detail}
              </span>
            ) : null}
            {filed.decisionId ? <Link href={`/desk/decision/${filed.decisionId}`}>Read the opinion</Link> : null}
            {filed.escalationId ? <Link href="/desk/approvals">Rule on the escalation</Link> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** An agent's run on one request: each tool call over MCP with its result, then the reply it posted. */
export function Transcript({ t, channel }: { t: T; channel: string }) {
  const tools = t.steps.filter((s) => s.kind === 'tool').length;
  return (
    <section className="transcript" aria-label="Agent transcript">
      <header className="transcript-head">
        <h2 className="h3">{AGENT_NAME[t.agent] ?? t.agent} handled it</h2>
        <span className="muted">
          {tools} tool {tools === 1 ? 'call' : 'calls'} over MCP, {(t.ms / 1000).toFixed(1)} s
        </span>
      </header>
      <ol className="transcript-steps">
        {t.steps.map((s, i) => (
          <StepRow key={`${s.kind}-${s.tool ?? ''}-${i}`} s={s} />
        ))}
      </ol>
      <blockquote className="reply">
        <p>{t.reply}</p>
        <footer>
          Reply posted to {channel} by the {AGENT_NAME[t.agent]?.toLowerCase() ?? t.agent}
        </footer>
      </blockquote>
    </section>
  );
}
