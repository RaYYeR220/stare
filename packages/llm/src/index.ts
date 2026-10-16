import { type Embedder, HashEmbedder, HeuristicLlm, type Llm } from '@stare/core';
import { VeniceEmbedder, VeniceLlm } from './models.ts';
import { VeniceClient } from './venice.ts';

export * from './cache.ts';
export * from './models.ts';
export * from './venice.ts';

export const DEFAULT_CHAT_MODEL = 'z-ai-glm-5-3-flash';
export const DEFAULT_EMBED_MODEL = 'text-embedding-qwen3-0-6b';
export const DEFAULT_EMBED_DIM = 512;

export interface ModelSetup {
  llm: Llm;
  embedder: Embedder;
  offline: boolean;
}

/** Models from the environment. Without a key Stare runs offline: regex intake, hashed embeddings, template explanations. */
export function modelsFromEnv(env = process.env, knownAccounts: string[] = []): ModelSetup {
  const key = env.VENICE_API_KEY;
  if (!key)
    return {
      llm: new HeuristicLlm(knownAccounts),
      embedder: new HashEmbedder(Number(env.STARE_EMBED_DIM ?? DEFAULT_EMBED_DIM)),
      offline: true,
    };
  const client = new VeniceClient(key, env.VENICE_BASE_URL ?? undefined);
  return {
    llm: new VeniceLlm(client, env.STARE_CHAT_MODEL ?? DEFAULT_CHAT_MODEL),
    embedder: new VeniceEmbedder(
      client,
      env.STARE_EMBED_MODEL ?? DEFAULT_EMBED_MODEL,
      Number(env.STARE_EMBED_DIM ?? DEFAULT_EMBED_DIM),
    ),
    offline: false,
  };
}
