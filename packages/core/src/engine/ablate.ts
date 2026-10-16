import { QueryRecorder } from '../db.ts';
import { REASONS } from '../llm.ts';
import type { EngineCtx } from './decide.ts';
import { RESOLVE_THRESHOLD } from './decide.ts';
import { Q } from './queries.ts';
import type { DecideRequest, Intake, Standing } from './types.ts';
import { POLICY_IDS } from './types.ts';

export interface Ablation {
  mode: 'structure-off';
  intake: Intake;
  outcome: 'approved' | 'counter' | 'no_precedent' | 'not_in_graph';
  value: number | null;
  precedent: {
    id: string;
    account: string;
    value: number;
    at: number;
    similarity: number;
    standing: Standing;
    covers: boolean;
  } | null;
  /** What the vector-only agent never looked at. */
  ignored: string[];
  trace: { name: string; cypher: string }[];
}

/**
 * "Structure off": what an agent with only vector retrieval would do on the same request. It takes the
 * most similar past exception granted under the same policy and follows it. No validity, no authority, no
 * policy versions, no coverage. The precedent's real flag is looked up afterwards, for the side-by-side.
 */
export async function ablate(ctx: EngineCtx, req: DecideRequest): Promise<Ablation> {
  const rec = new QueryRecorder();
  const db = ctx.db.withRecorder(rec);
  const now = ctx.clock.now();
  const intake =
    req.intake ?? (await ctx.llm.parseRequest(req.text ?? '', { policies: POLICY_IDS, reasons: REASONS }));
  const res: Ablation = {
    mode: 'structure-off',
    intake,
    outcome: 'no_precedent',
    value: null,
    precedent: null,
    ignored: [
      'whether the precedent is still good law',
      'who approved it and whether they could',
      'the policy version in force',
      'the agent’s delegation',
      'the autonomy budget',
    ],
    trace: [],
  };
  const [acc] = intake.accountName
    ? await db.ro<{ id: string; tier: string }>(Q.resolveAccount, {
        name: intake.accountName,
        threshold: RESOLVE_THRESHOLD,
        now,
      })
    : [];
  if (!acc || !intake.policyId || intake.value == null) {
    res.outcome = 'not_in_graph';
    return res;
  }
  const [vec] = await ctx.embedder.embed([
    req.text || `${intake.accountName} ${intake.policyId} ${intake.value} ${intake.reason}`,
  ]);
  const seeds = await db.ro<{ id: string; score: number }>(Q.vectorSeeds, {
    k: 24,
    vec,
    policyId: intake.policyId,
    now,
  });
  if (seeds.length) {
    const facts = JSON.stringify({
      policyId: intake.policyId,
      value: intake.value,
      days: intake.days,
      reason: intake.reason,
      tier: acc.tier,
    });
    const rows = await db.ro<{
      id: string;
      value: number;
      at: number;
      outcome: string;
      basis: string;
      account: string;
      standing: Standing;
      cover: { covers: boolean };
    }>(Q.evaluateCandidates, { ids: seeds.map((s) => s.id), facts, now });
    const sim = new Map(seeds.map((s) => [s.id, 1 - s.score]));
    const top = rows
      .filter((r) => r.outcome === 'approved' && r.basis !== 'routine')
      .sort((a, b) => (sim.get(b.id) ?? 0) - (sim.get(a.id) ?? 0))[0];
    if (top) {
      res.precedent = {
        id: top.id,
        account: top.account,
        value: top.value,
        at: top.at,
        similarity: Math.round((sim.get(top.id) ?? 0) * 1000) / 1000,
        standing: top.standing,
        covers: top.cover.covers,
      };
      res.outcome = top.value >= intake.value ? 'approved' : 'counter';
      res.value = Math.min(top.value, intake.value);
    }
  }
  res.trace = rec.entries.map((e) => ({ name: e.name, cypher: e.cypher }));
  return res;
}
