'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Glyph } from '@/components/Glyph';
import { FLAG_NAME, term, value as fmt } from '@/lib/format';
import type { Flag } from '@/lib/types';

export interface PlateNode {
  id: string;
  account: string;
  value: number | null;
  at: number | null;
  madeBy: string | null;
  flag: Flag;
  /** "o" tag: who overturned it. */
  overturnedBy?: string;
}

export interface PlateEdge {
  from: string;
  to: string;
}

const W = 196;
const H = 70;
const GX = 52;
const GY = 26;
const PAD = 12;

/**
 * The appendix plate: a decision, what it cites (to the right, by hops) and, after a reversal, what
 * rests on it (to the left). Edges are citations ("f", followed); a red "o" tag marks an overturned node.
 */
export function Plate({ rootId, nodes, edges, followers, policy }: { rootId: string; nodes: PlateNode[]; edges: PlateEdge[]; followers: string[]; policy: string | null }) {
  const router = useRouter();
  const [hover, setHover] = useState<string | null>(null);

  const depth = new Map<string, number>([[rootId, 0]]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges) {
      if (e.from === id && !depth.has(e.to)) {
        depth.set(e.to, (depth.get(id) ?? 0) + 1);
        queue.push(e.to);
      }
    }
  }
  for (const f of followers) if (!depth.has(f)) depth.set(f, -1);
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 1);

  const cols = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    cols.set(d, [...(cols.get(d) ?? []), n.id]);
  }
  const minD = Math.min(...cols.keys());
  const maxD = Math.max(...cols.keys());
  const tallest = Math.max(...[...cols.values()].map((c) => c.length));
  const height = PAD * 2 + tallest * H + (tallest - 1) * GY + 22;
  const width = PAD * 2 + (maxD - minD + 1) * W + (maxD - minD) * GX;

  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of cols) {
    const colH = ids.length * H + (ids.length - 1) * GY;
    const top = PAD + (tallest * H + (tallest - 1) * GY - colH) / 2;
    ids.forEach((id, i) => pos.set(id, { x: PAD + (d - minD) * (W + GX), y: top + i * (H + GY) }));
  }

  const allEdges = [...edges, ...followers.map((f) => ({ from: f, to: rootId }))];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Precedent chain for this decision">
      <title>Precedent chain</title>
      {allEdges.map((e) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const x1 = a.x + W;
        const y1 = a.y + H / 2;
        const x2 = b.x;
        const y2 = b.y + H / 2;
        const mx = x1 + (x2 - x1) / 2;
        const lit = hover === e.from || hover === e.to;
        return (
          <g key={`${e.from}>${e.to}`} opacity={hover && !lit ? 0.35 : 1}>
            <path className="plate-edge" d={`M${x1} ${y1}H${mx}V${y2}H${x2}`} />
            <g className="plate-tag" transform={`translate(${x1 + 6} ${y1 - 8})`}>
              <rect width="16" height="16" />
              <text x="8" y="11.5" textAnchor="middle">
                f
              </text>
            </g>
          </g>
        );
      })}
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const go = () => router.push(`/desk/decision/${n.id}`);
        return (
          <g
            key={n.id}
            className={`plate-node${n.id === rootId ? ' root' : ''}`}
            transform={`translate(${p.x} ${p.y})`}
            role="link"
            tabIndex={0}
            aria-label={`${n.account}, ${n.id}, ${FLAG_NAME[n.flag]}`}
            style={{ cursor: 'pointer' }}
            onClick={go}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go();
            }}
            onPointerEnter={() => setHover(n.id)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(n.id)}
            onBlur={() => setHover(null)}
          >
            <rect width={W} height={H} />
            <g transform="translate(12 12)">
              <Glyph signal={n.flag} title={false} />
            </g>
            <text x="36" y="25" style={{ fontFamily: 'var(--serif)', fontSize: 15, fontStyle: 'italic' }}>
              {n.account.length > 20 ? `${n.account.slice(0, 19)}…` : n.account}
            </text>
            <text x="12" y="45" style={{ fontFamily: 'var(--mono)', fontSize: 10.5, fill: 'var(--ink-3)' }}>
              {n.id}
              {n.value != null ? `  ${fmt(policy, n.value)}` : ''}
            </text>
            <text x="12" y="60" style={{ fontSize: 11, fill: 'var(--ink-3)' }}>
              {[n.madeBy, n.at ? term(n.at) : null].filter(Boolean).join(', ')}
            </text>
            {n.overturnedBy ? (
              <g className="plate-tag o" transform={`translate(${W - 24} 8)`}>
                <title>Overturned by {n.overturnedBy}</title>
                <rect width="16" height="16" />
                <text x="8" y="11.5" textAnchor="middle">
                  o
                </text>
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
