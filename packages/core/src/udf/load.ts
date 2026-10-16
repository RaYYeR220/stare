import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FalkorDB } from 'falkordb';

export const UDF_LIBRARY = 'stare';

export function udfSource(): string {
  return readFileSync(fileURLToPath(new URL('./stare.js', import.meta.url)), 'utf8');
}

/** Loads (or replaces) the server-global `stare` UDF library. Admin connection only. */
export async function loadUdf(admin: FalkorDB, replace = true): Promise<void> {
  await admin.udfLoad(UDF_LIBRARY, udfSource(), replace);
}
