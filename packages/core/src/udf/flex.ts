import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FalkorDB } from 'falkordb';

/** FalkorDB's FLEX UDF library, pinned. Downloaded at setup (not vendored) and checked by hash. */
export const FLEX_VERSION = '1.0.1';
export const FLEX_URL = `https://github.com/FalkorDB/flex/releases/download/${FLEX_VERSION}/flex.js`;
export const FLEX_SHA256 = 'e7e833ba87f88c1e31913b58bb9bdeab231714f8af4b43b437d84277ee653ece';

const defaultCache = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.cache', `flex-${FLEX_VERSION}.js`);

export async function flexSource(cachePath = process.env.STARE_FLEX_PATH ?? defaultCache): Promise<string> {
  let src: string;
  if (existsSync(cachePath)) src = readFileSync(cachePath, 'utf8');
  else {
    const res = await fetch(FLEX_URL);
    if (!res.ok) throw new Error(`could not download FLEX ${FLEX_VERSION}: HTTP ${res.status}`);
    src = await res.text();
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, src);
  }
  const got = createHash('sha256').update(src).digest('hex');
  if (got !== FLEX_SHA256) throw new Error(`FLEX checksum mismatch: ${got}`);
  return src;
}

export async function loadFlex(admin: FalkorDB): Promise<void> {
  await admin.udfLoad('flex', await flexSource(), true);
}
