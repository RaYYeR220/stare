# Reviewing Stare in five minutes

Everything below runs on the live deployment: no sign-up, no keys. Each visitor gets a private copy of the demo company (Northwind Cloud) for two hours, so you can change anything.

**1. Open the desk.** https://stare-desk.vercel.app, then **Open the desk**.

**2. The request that started it** (*Advance sheets*, first request, Acme Logistics, $1,800). Press **Decide**.
- The desk counter-offers **$1,200**. That is what the strongest precedent that is still good law supports (headnote [1], ◆).
- "Not relied on": the closest-looking precedent, Bluefin Analytics, is ▲ Overruling Risk. It cites Kestrel Foods, which a support specialist approved without any refund authority (⬣ `NO_AUTHORITY`).
- The claim "our VP already signed off" is struck as "not evidence".
- **Appendix:** every Cypher query that ran, by name, with timings. `engine.evaluateCandidates` is where `stare.standing` runs inside FalkorDB.
- Toggle **Strike the citations**: a vector-only agent on the same request follows the nearest past exception, whose real flag is shown.

**3. Change history and watch it propagate.**
- Open any precedent (headnotes link to their decision page) and **Overturn** it: everything that cited it turns ▲ on the plate.
- **Policy:** tighten a hard limit and **Simulate**. It runs on a `GRAPH.COPY`, then reports precedents that stop being good law, rules quarantined, and agent autonomy before → after. **Adopt** to make it real.
- **People:** depart someone. Their past decisions keep their flags (authority is judged at the time), but delegations they backed stop working.

**4. Ask a person.** *Approvals*: rule on an escalation as different people. Someone without enough authority, the account owner, or the person who filed it is refused with the database's reason. Exceptions past a hard limit are refused for everyone.

**5. Forget with proof.** *Erasure*: erase Marta Lindqvist (Acme Logistics).
- The certificate passes C1–C4.
- Next to it, the naive "delete the contact node" control, run on a copy, is **refused** by the same checks.
- The business record survives: decisions keep their authority and citations, and are re-grounded on the erasure record.

**6. Proof tab.**
- **Race:** 64 concurrent requests from three agents on 16 connections, with every invariant checked in the graph. It runs on a throwaway copy of your desk, so your budgets stay as they were.
- **Isolation:** your desk's own FalkorDB user tries another tenant's graph, `GRAPH.LIST`, `GRAPH.COPY` and `GRAPH.UDF`. Each attempt gets FalkorDB's verbatim `NOPERM`, read back from `ACL LOG`.
- **Ledger:** recomputed end to end.
- **Evaluation:** the sealed 112-case table.
- **Algorithms:** PageRank leading cases, betweenness bottlenecks, label-propagation clusters.

**7. Agents and MCP.**
- *Advance sheets → Hand to the agent* runs a model-driven agent that works only through the desk's MCP tools: recall → file_exception → remember. The transcript shows each call.
- *Connect* gives an MCP URL and a bearer token bound to one principal in your desk. The server speaks spec 2026-07-28.
- *Connect* also gives the read-only **auditor**: FalkorDB's own MCP server with a user that can only `GRAPH.RO_QUERY` one tenant's graph. Try a `CREATE` or another graph through it; FalkorDB refuses.

**Where to look in the code**
- `packages/core/src/udf/stare.js`: good law, coverage, SHA-256, the erasure scanner (FalkorDB UDFs).
- `packages/core/src/engine/queries.ts`: every query the engine runs. All of them are listed in [`docs/queries.md`](docs/queries.md).
- `packages/eval/cases/SEAL`: the hash committed before any run.
- [`CLAIMS.md`](CLAIMS.md): each claim with its proof. `pnpm test` runs 99 tests against a real FalkorDB.
