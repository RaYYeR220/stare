import { Glyph } from '@/components/Glyph';
import { Hero } from '@/components/landing/Hero';
import { OpenDesk } from '@/components/landing/OpenDesk';
import { TableOfCases } from '@/components/landing/TableOfCases';
import { API_BASE } from '@/lib/api';
import { count, money } from '@/lib/format';
import type { EvalResults } from '@/lib/types';
import './landing.css';

export const revalidate = 300;

async function loadEvaluation(): Promise<EvalResults | null> {
  try {
    const res = await fetch(`${API_BASE}/api/eval`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(6000) });
    return res.ok ? ((await res.json()) as EvalResults) : null;
  } catch {
    return null;
  }
}

const MCP_SNIPPET = (url: string) => `{
  "mcpServers": {
    "stare": {
      "type": "http",
      "url": "${url}/mcp",
      "headers": { "Authorization": "Bearer <token from the desk>" }
    }
  }
}`;

export default async function Landing() {
  const evaluation = await loadEvaluation();
  const s = evaluation?.arms.stare;
  const aside =
    s && evaluation
    ? `Vol. 3, Northwind Cloud, Oct. 2026. ${count(evaluation.cases)} sealed cases, ${count(s.falseApprovals)} false approvals.`
    : 'Vol. 3, Northwind Cloud, Oct. 2026. A private copy of the company, yours for two hours.';

  return (
    <div className="landing">
      <Hero aside={aside} />

      <section className="verbs" aria-labelledby="verbs-title">
        <h2 id="verbs-title" className="section-title">
          How an exception gets decided
        </h2>
        <ol className="verb-list">
          <li className="verb">
            <span className="verb-no">1</span>
            <h3>Check standing</h3>
            <p>
              A support, renewals or billing agent receives a request for a refund, a discount or longer payment terms.
              Stare finds the precedents that cover it and checks each one inside FalkorDB, the way a citator checks a
              case: overturned, approved without authority, superseded by today’s policy, decided under a conflict of
              interest, or resting on any of those.
            </p>
            <ul className="legend">
              <li>
                <Glyph signal="green" /> <b>Good law</b> followed, and safe to stand on
              </li>
              <li>
                <Glyph signal="yellow" /> <b>Overruling Risk</b> rests on a precedent that is no longer good law
              </li>
              <li>
                <Glyph signal="red" /> <b>Not good law</b> overturned, no authority, superseded or conflicted
              </li>
              <li>
                <Glyph signal="pending" /> <b>Pending</b> waiting on the person the authority graph names
              </li>
            </ul>
          </li>
          <li className="verb">
            <span className="verb-no">2</span>
            <h3>Act or escalate</h3>
            <p>
              On good law, inside its delegation and its autonomy budget, the agent acts and cites. Otherwise it offers
              what the precedent supports, escalates along the reporting line to the nearest person whose authority
              covers the amount, or refuses and names the clause. Claims inside a request, like “the VP already
              approved”, are not evidence.
            </p>
            <ol className="commission" aria-label="Example chain of commission">
              <li>
                <span>Renewals agent</span>
                <small>delegated up to 20% by Marcus Chen</small>
              </li>
              <li>
                <span>Marcus Chen</span>
                <small>Renewals Director, may approve 25%</small>
              </li>
              <li className="commission-end">
                <span>Dana Whitfield</span>
                <small>VP Sales, may approve 35%: the request for 32% goes here</small>
              </li>
            </ol>
          </li>
          <li className="verb">
            <span className="verb-no">3</span>
            <h3>Prove it</h3>
            <p>
              People’s rulings become precedent, and precedent that keeps holding up is ratified into standing rules an
              agent runtime can load as a skill. Every decision, escalation, policy change and erasure is a link in a hash
              chain computed inside the database. Erasing a customer contact issues a certificate with four checks, beside a
              naive delete that fails them.
            </p>
            <ul className="checks" aria-label="The four checks of a certificate of erasure">
              <li>
                <code>C1</code> No property anywhere still names the subject
              </li>
              <li>
                <code>C2</code> The subject and their salt are gone
              </li>
              <li>
                <code>C3</code> No stored vector still encodes them
              </li>
              <li>
                <code>C4</code> The ledger verifies end to end
              </li>
            </ul>
          </li>
        </ol>
      </section>

      <section className="method" id="method" aria-labelledby="method-title">
        <div className="method-head">
          <h2 id="method-title" className="section-title">
            Table of Cases
          </h2>
          <p className="method-note">
            {evaluation ? `${count(evaluation.cases)} cases` : 'Cases'} across thirteen trap classes, written and sealed
            before any arm ran. Stare uses its model only to read the request; the baselines decide with the model, one of
            them with top-8 vector retrieval over the same precedents.
          </p>
        </div>
        <TableOfCases data={evaluation} />
        {s && evaluation ? (
          <p className="method-sum">
            Stare: {count(s.correct)} of {count(evaluation.cases)} correct and {money(s.leakedUsd)} refunded in error.
            Vector RAG leaked {money(evaluation.arms.rag.leakedUsd)}; the model on its own, {money(evaluation.arms.llm.leakedUsd)}.
          </p>
        ) : null}
      </section>

      <section className="connect" aria-labelledby="connect-title">
        <div>
          <h2 id="connect-title" className="section-title">
            Connect any MCP client
          </h2>
          <p>
            The desk speaks MCP over stateless HTTP. Open a desk, choose who the client acts as, and paste the token it
            gives you. The client gets <code>file_exception</code>, <code>find_precedent</code>,{' '}
            <code>check_standing</code>, <code>who_can_approve</code>, <code>recall</code> and the rest; a confirmation
            arrives as an input request, and the token never grants more than the one principal it names.
          </p>
          <OpenDesk label="Open the desk" />
        </div>
        <pre className="snippet" aria-label="MCP client configuration">
          <code>{MCP_SNIPPET(API_BASE)}</code>
        </pre>
      </section>

      <footer className="colophon">
        <span className="colophon-mark">Stare</span>
        <span>Northwind Cloud is a fictional company; every desk is a private copy that closes after two hours.</span>
        <a href="https://github.com/RaYYeR220/stare">github.com/RaYYeR220/stare</a>
        <a href="https://www.falkordb.com">Built on FalkorDB</a>
      </footer>
    </div>
  );
}
