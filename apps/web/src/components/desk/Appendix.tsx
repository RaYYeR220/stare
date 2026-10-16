import type { TraceEntry } from '@/lib/types';

function params(p: Record<string, unknown>): string {
  return Object.entries(p)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `$${k} = ${s && s.length > 140 ? `${s.slice(0, 140)}…` : s}`;
    })
    .join('   ');
}

/** The Appendix: every named Cypher query the decision ran, with its timing; the text opens on demand. */
export function Appendix({ trace }: { trace: TraceEntry[] }) {
  const total = Math.round(trace.reduce((s, t) => s + t.ms, 0) * 10) / 10;
  const writes = trace.filter((t) => t.mode === 'rw').length;
  return (
    <section className="appendix" aria-label="Appendix: the Cypher that ran">
      <h3 className="op-h">Appendix</h3>
      <p className="op-note" style={{ marginTop: 0, marginBottom: 12 }}>
        {trace.length} named queries ran in FalkorDB, {writes} of them writes, {total} ms in the database. Open any line for
        its Cypher.
      </p>
      <ol className="appendix-list">
        {trace.map((t, i) => (
          <li key={`${t.name}-${i}`}>
            <details>
              <summary>
                <code>{t.name}</code>
                <span className={t.mode === 'rw' ? 'mode-rw' : 'mode-ro'}>{t.mode}</span>
                <span className="appendix-num">{t.rows === 1 ? '1 row' : `${t.rows} rows`}</span>
                <span className="appendix-num">{t.ms} ms</span>
              </summary>
              <pre>
                <code>{t.cypher}</code>
              </pre>
              {Object.keys(t.params).length ? <p className="appendix-params mono">{params(t.params)}</p> : null}
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
