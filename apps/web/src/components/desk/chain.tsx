'use client';

import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Glyph } from '@/components/Glyph';
import { useDesk } from '@/lib/desk';
import { CODE_GLOSS } from '@/lib/format';
import type { Flag, Standing } from '@/lib/types';

export interface Known {
  account: string;
  flag: Flag;
  codes: string[];
}

/**
 * Names and live flags for the decisions in a precedent chain. Whatever the verdict already carried is
 * used as is; the rest is read from the decision view, once per id.
 */
export function useKnown(seed: Record<string, Known>, ids: string[]): Record<string, Known> {
  const { api } = useDesk();
  const [fetched, setFetched] = useState<Record<string, Known>>({});
  const missing = useMemo(() => [...new Set(ids)].filter((id) => !seed[id]), [ids, seed]);
  const missingKey = missing.join(',');

  useEffect(() => {
    if (!missingKey) return;
    let live = true;
    const wanted = missingKey.split(',').slice(0, 8);
    Promise.all(
      wanted.map((id) =>
        api
          .decision(id)
          .then((v) => [id, { account: v.decision.account ?? id, flag: v.decision.standing.flag, codes: v.decision.standing.reasons.map((r) => r.code) }] as const)
          .catch(() => null),
      ),
    ).then((rows) => {
      if (!live) return;
      const next: Record<string, Known> = {};
      for (const r of rows) if (r) next[r[0]] = r[1];
      setFetched((f) => ({ ...f, ...next }));
    });
    return () => {
      live = false;
    };
  }, [api, missingKey]);

  return useMemo(() => ({ ...fetched, ...seed }), [fetched, seed]);
}

export function CodeChip({ code }: { code: string }) {
  return (
    <span className="code-chip" title={CODE_GLOSS[code] ?? code}>
      {code}
    </span>
  );
}

/** "Bluefin Analytics ▲ rests on Kestrel Foods ⬣ NO_AUTHORITY": why a precedent is not good law, link by link. */
export function ChainLine({ id, account, standing, known }: { id: string; account: string; standing: Standing; known: Record<string, Known> }) {
  const links = standing.chain.map((cid) => ({ id: cid, k: known[cid] }));
  const ownCodes = standing.reasons.map((r) => r.code).filter((c) => c !== 'RESTS_ON_RED');
  return (
    <span className="chain">
      <span className="chain-link">
        <Glyph signal={standing.flag} />
        <Link href={`/desk/decision/${id}`}>
          <i>{account}</i>
        </Link>
        {ownCodes.map((c) => (
          <CodeChip key={c} code={c} />
        ))}
      </span>
      {links.map(({ id: cid, k }) => (
        <Fragment key={cid}>
          <span className="chain-arrow">rests on</span>
          <span className="chain-link">
            {k ? <Glyph signal={k.flag} /> : null}
            <Link href={`/desk/decision/${cid}`}>
              <i>{k?.account ?? cid}</i>
            </Link>
            {k && k.flag === 'red'
              ? k.codes
                  .filter((c) => c !== 'RESTS_ON_RED')
                  .map((c) => <CodeChip key={c} code={c} />)
              : null}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
