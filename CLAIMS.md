# Claims and how to check them

Every public statement about Stare, with the evidence behind it. **Reproducible** means a command in this repository proves it. **Live** means you can see it on the deployed desk. **Measured** means it comes from the evaluation run. **Not claimed** marks things we deliberately do not claim.

| Claim | Evidence | How to check |
|---|---|---|
| Precedent validity is computed inside FalkorDB, not by the model | Reproducible | `packages/core/src/udf/stare.js` is loaded with `GRAPH.UDF LOAD`. Every decision's trace lists `engine.evaluateCandidates`, which calls `stare.standing` and `stare.covers` in Cypher. |
| The database UDF and an independent implementation agree on every seeded decision | Reproducible | `pnpm test` → `packages/seed/test/seed.test.ts`, "the database UDF and the independent TypeScript mirror agree on every decision" |
| Authority is judged at the time of the decision; a departed approver's decisions stay good law | Reproducible, Live | `standing.test.ts` "approver who left later does not invalidate…"; on the desk, **People → Depart** anyone, then open their decisions |
| An overturned decision turns everything that relies on it into Overruling Risk, and quarantines rules derived from it | Reproducible, Live | `lifecycle.test.ts` "overturning a basis decision quarantines the rule…"; on the desk, **Decision → Overturn** |
| A policy change re-flags precedent; the simulator runs on a copy and changes nothing | Reproducible, Live | `lifecycle.test.ts` "policy impact runs on a copy…"; desk **Policy → Simulate** |
| Anything unverifiable fails closed (cycles, deep chains, missing facts, unreadable clauses, missing policy) | Reproducible | `standing.test.ts`, `udf.test.ts` |
| Claims inside a request ("the VP approved") never change an outcome | Reproducible, Measured | `engine.test.ts` "ignores instructions and claims…"; eval class `injected_claim` 10/10 |
| A lookalike company from another tenant is not resolved to one of ours | Reproducible | `engine.test.ts` "matches typos but not lookalike companies…"; eval class `cross_tenant` 6/6 |
| Each request is decided once, even when retried concurrently | Reproducible | `engine.test.ts` "is idempotent…" (8 concurrent duplicates → one decision) |
| 64 concurrent requests from three agents never overspend the budget, never decide a case twice, never fork the ledger | Reproducible, Live | `platform.test.ts` "64 concurrent requests…"; desk **Proof → Race** |
| Tenant isolation is enforced by FalkorDB, not by the application | Reproducible, Live | `platform.test.ts` "a sandbox user … gets NOPERM everywhere else, logged in ACL LOG"; desk **Proof → Isolation** shows the database's verbatim errors |
| FalkorDB's own MCP server, given a read-only tenant user, can read but cannot write or reach another tenant | Live | desk **Connect → Auditor**: `query_graph` on `stare:globex` → `NOPERM No permissions to access a key`; `CREATE` → `NOPERM … 'graph.QUERY'` |
| The ledger is a hash chain computed inside the write, verified outside it, and matched to every live decision | Reproducible, Live | `ledger.test.ts`; desk **Proof → Ledger** |
| Erasure removes the subject everywhere and keeps the business record; a naive delete fails the same checks | Reproducible, Live | `erasure.test.ts`; desk **Erasure** shows the certificate next to the refused control |
| A person must confirm rulings through an MCP multi-round-trip input request; agents cannot rule | Reproducible | `packages/server/test/server.test.ts` "a person approves through an elicitation…" |
| Explanations that name anyone or any amount outside the trace are rejected | Reproducible | `engine.test.ts` "explanation gate…" |
| Stare 112/112 (five runs), vector RAG 68/112 with $14,500 leaked, LLM-only 66/112 with $17,200 leaked (latest run; an earlier run is kept in `results/history`) | Measured | `packages/eval/results/report.md`; the key's hash in `packages/eval/cases/SEAL` was committed before the first run (see the commit history) |
| Stare's 112/112 shows the system is better than the baselines in general | **Not claimed** | The key and the engine encode the same rules; the evaluation measures the baselines' failure modes, and the request parser is the only stochastic part of Stare |
| Production readiness | **Not claimed** | One VM, one FalkorDB instance, synthetic data, demo tokens instead of SSO |
