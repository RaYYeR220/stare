import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Embedder } from '@stare/core';

/**
 * Embeddings cached on disk (float32, base64) keyed by model, dimension and text hash. The seed ships
 * with its cache so anyone can rebuild the demo tenants without an API key.
 */
export class CachedEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private cache: Record<string, string>;
  private dirty = false;

  constructor(
    private inner: Embedder | null,
    private path: string,
    model?: string,
    dim?: number,
  ) {
    this.model = inner?.model ?? model ?? 'cache';
    this.dim = inner?.dim ?? dim ?? 512;
    this.cache = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  }

  private key(t: string) {
    return createHash('sha256').update(`${this.model}|${this.dim}|${t}`).digest('hex').slice(0, 32);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const missing = [...new Set(texts.filter((t) => !this.cache[this.key(t)]))];
    if (missing.length) {
      if (!this.inner)
        throw new Error(
          `${missing.length} text(s) not in the embedding cache and no embedding model configured`,
        );
      const vecs = await this.inner.embed(missing);
      missing.forEach((t, i) => {
        this.cache[this.key(t)] = Buffer.from(new Float32Array(vecs[i]!).buffer).toString('base64');
      });
      this.dirty = true;
    }
    return texts.map((t) => {
      const b = Buffer.from(this.cache[this.key(t)]!, 'base64');
      return Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
    });
  }

  save() {
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(this.cache).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(this.path, JSON.stringify(sorted));
    this.dirty = false;
  }
}
