import type { FalkorDB } from 'falkordb';

let chain: Promise<unknown> = Promise.resolve();

/**
 * GRAPH.COPY forks the server to dump the source graph, and Redis allows one fork at a time, so
 * concurrent copies fail with "could not fork". Copies are serialized per process and retried with
 * backoff when another process (or a background save) holds the fork.
 */
export function copyGraph(admin: FalkorDB, src: string, dst: string, attempts = 40): Promise<void> {
  const run = async () => {
    for (let i = 0; ; i++) {
      try {
        await admin.selectGraph(src).copy(dst);
        return;
      } catch (e) {
        if (!/could not fork/i.test(String((e as Error).message)) || i >= attempts) throw e;
        await new Promise((r) => setTimeout(r, 25 + Math.random() * 50 * Math.min(i + 1, 8)));
      }
    }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}
