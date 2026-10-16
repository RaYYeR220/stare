import { count, money, short } from '@/lib/format';
import type { EvalResults } from '@/lib/types';

const ARMS: { key: keyof EvalResults['arms']; name: string }[] = [
  { key: 'stare', name: 'Stare' },
  { key: 'rag', name: 'Vector RAG' },
  { key: 'llm', name: 'LLM only' },
];

/** Trap classes of the evaluation, in the order a reader meets them. */
export const CLASS_NAME: Record<string, string> = {
  routine: 'Routine, inside policy',
  precedent: 'Covered by good-law precedent',
  rule: 'Covered by a standing rule',
  superseded: 'Precedent superseded by policy',
  goodwill: 'Goodwill, barred by policy',
  collections: 'Account in collections',
  overruling_risk: 'Overruling Risk',
  lookalike_bad_precedent: 'Lookalike of a bad precedent',
  departed_approver: 'Approver has since left',
  over_delegation: 'Above the agent’s delegation',
  injected_claim: 'Injected claim in the request',
  unknown_entity: 'Customer not in the graph',
  cross_tenant: 'Another tenant’s customer',
};

function Bar({ share, lead }: { share: number; lead: boolean }) {
  return (
    <span className="toc-bar" aria-hidden="true">
      <span className={lead ? 'toc-fill toc-lead' : 'toc-fill'} style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }} />
    </span>
  );
}

export function TableOfCases({ data }: { data: EvalResults | null }) {
  if (!data) {
    return (
      <p className="toc-missing">
        The evaluation results could not be fetched just now. They are public at <code>/api/eval</code> on the desk server.
      </p>
    );
  }
  const classes = Object.keys(data.arms.stare.perClass);
  return (
    <>
      <div className="toc-scroll">
        <table className="toc">
          <caption className="visually-hidden">Evaluation over {data.cases} sealed cases, by arm</caption>
          <thead>
            <tr>
              <th scope="col">Arm</th>
              <th scope="col" className="toc-num">
                Correct of {data.cases}
              </th>
              <th scope="col" className="toc-num">
                False approvals
              </th>
              <th scope="col" className="toc-num">
                Refund dollars leaked
              </th>
              <th scope="col" className="toc-num toc-wide">
                False refusals
              </th>
            </tr>
          </thead>
          <tbody>
            {ARMS.map(({ key, name }) => {
              const a = data.arms[key];
              const lead = key === 'stare';
              return (
                <tr key={key} className={lead ? 'toc-row-lead' : undefined}>
                  <th scope="row">
                    <span className="toc-arm">{name}</span>
                    <span className="toc-model">{a.model}</span>
                  </th>
                  <td className="toc-num">
                    <span className="toc-cell">
                      <span className="toc-figure">{count(a.correct)}</span>
                      <Bar share={a.correct / a.n} lead={lead} />
                    </span>
                  </td>
                  <td className="toc-num">
                    <span className="toc-figure">{count(a.falseApprovals)}</span>
                  </td>
                  <td className="toc-num">
                    <span className="toc-figure">{money(a.leakedUsd)}</span>
                  </td>
                  <td className="toc-num toc-wide">
                    <span className="toc-figure">{count(a.falseRefusals)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="toc-classes">
        <summary>By trap class ({classes.length})</summary>
        <div className="toc-scroll">
          <table className="toc toc-matrix">
            <caption className="visually-hidden">Correct answers per trap class and arm</caption>
            <thead>
              <tr>
                <th scope="col">Trap class</th>
                {ARMS.map((a) => (
                  <th key={a.key} scope="col" className="toc-num">
                    {a.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => (
                <tr key={c}>
                  <th scope="row">{CLASS_NAME[c] ?? c}</th>
                  {ARMS.map(({ key }) => {
                    const r = data.arms[key].perClass[c] ?? { n: 0, ok: 0 };
                    return (
                      <td key={key} className="toc-num">
                        <span className="toc-cell">
                          <span className="toc-figure">
                            {r.ok}/{r.n}
                          </span>
                          <Bar share={r.n ? r.ok / r.n : 0} lead={key === 'stare'} />
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <p className="toc-seal">
        Answer key sealed before any arm ran, sha256 <code title={data.sealedKeySha256}>{short(data.sealedKeySha256, 16)}</code>,
        run {data.ranAt.slice(0, 10)}.
      </p>
    </>
  );
}
