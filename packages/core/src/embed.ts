import { createHash } from 'node:crypto';

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

function l2(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/**
 * Deterministic feature-hashing embedder (unigrams + bigrams). Used by the test suite and as an
 * explicit offline mode; it is never presented as a semantic model.
 */
export class HashEmbedder implements Embedder {
  readonly model: string;
  constructor(readonly dim = 512) {
    this.model = `hash-${dim}`;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dim).fill(0);
      const toks = t.toLowerCase().match(/[a-z0-9$%]+/g) ?? [];
      const feats = [...toks, ...toks.slice(1).map((x, i) => `${toks[i]}_${x}`)];
      for (const f of feats) {
        const h = createHash('sha1').update(f).digest();
        const idx = h.readUInt32BE(0) % this.dim;
        v[idx]! += h[4]! & 1 ? 1 : -1;
      }
      return l2(v);
    });
  }
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
