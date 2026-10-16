import { beforeAll, describe, expect, it } from 'vitest';
import { resolveEscalation } from '../src/approve.ts';
import { decide } from '../src/engine/decide.ts';
import { adoptPolicy, departPerson, draftFromCurrent, flagsAt, overturnDecision, policyImpact } from '../src/impact.ts';
import { verifyLedger } from '../src/ledger.ts';
import { listRules, proposeRules, ratifyRule, renderSkill } from '../src/rules.ts';
import { adminClient } from './helpers.ts';
import { ctxOn, inbox, northwindBase, NOW, nw } from './northwind.ts';

let base: string;
beforeAll(async () => {
  base = await northwindBase('life');
}, 120_000);

describe('human rulings on escalations', () => {
  it('the routed approver approves; the ruling becomes precedent and is ledgered', async () => {
    const ctx = await ctxOn(base);
    const esc = await decide(ctx, inbox('in-churn-yellow'));
    expect(esc.outcome).toBe('escalated');
    const r = await resolveEscalation(ctx, { escalationId: esc.escalationId!, personId: 'p-priya', approve: true, note: 'Signed renewal attached.' });
    expect(r).toMatchObject({ ok: true, outcome: 'approved', value: 1500 });
    const [row] = await ctx.db.ro<{ s: { flag: string } }>('MATCH (d:Decision {id:$id}) RETURN stare.standing(d, $now) AS s', { id: r.decisionId, now: NOW });
    expect(row!.s.flag).toBe('green');
    expect((await verifyLedger(ctx.db, { deep: true })).ok).toBe(true);
  });

  it('refuses someone without enough authority, and an approver who owns the account', async () => {
    const ctx = await ctxOn(base);
    const esc = await decide(ctx, inbox('in-churn-yellow'));
    const low = await resolveEscalation(ctx, { escalationId: esc.escalationId!, personId: 'p-kofi', approve: true });
    expect(low.refusal?.code).toBe('NOT_AUTHORIZED');
    const owner = nw.owns.find((o) => o.account === esc.account!.id)!.person;
    await ctx.db.rw("MATCH (p:Person {id:$p}), (r:Role {id:'r-vp-cs'}) CREATE (p)-[:HOLDS {validFrom:0, validTo:253402300799000}]->(r)", { p: owner });
    const conflicted = await resolveEscalation(ctx, { escalationId: esc.escalationId!, personId: owner, approve: true });
    expect(conflicted.refusal?.code).toBe('CONFLICT');
    const [c] = await ctx.db.ro<{ n: number }>('MATCH (d:Decision {caseId:$c}) RETURN count(d) AS n', { c: esc.caseId });
    expect(c!.n).toBe(0);
  });

  it('nobody can approve past a hard policy limit, whatever their authority', async () => {
    const ctx = await ctxOn(base);
    const esc = await decide(ctx, inbox('in-churn-yellow'));
    const r = await resolveEscalation(ctx, { escalationId: esc.escalationId!, personId: 'p-daniel', approve: true, value: 1500 });
    expect(r.ok).toBe(true);
    const esc2 = await decide(ctx, { ...inbox('in-churn-yellow'), key: 'second' });
    const bad = await resolveEscalation(ctx, { escalationId: esc2.escalationId!, personId: 'p-daniel', approve: true, value: -5 });
    expect(bad.refusal?.code).toBe('BAD_VALUE');
    const more = await resolveEscalation(ctx, { escalationId: esc2.escalationId!, personId: 'p-daniel', approve: true, value: 9000 });
    expect(more.refusal?.code).toBe('BAD_VALUE');
  });

  it('a person cannot rule on their own request', async () => {
    const ctx = await ctxOn(base);
    const esc = await decide(ctx, { principal: { kind: 'person', id: 'p-priya' }, text: nw.inbox.find((i) => i.id === 'in-churn-yellow')!.text });
    expect(esc.outcome).toBe('escalated');
    expect(esc.route?.personId).not.toBe('p-priya');
    const r = await resolveEscalation(ctx, { escalationId: esc.escalationId!, personId: 'p-priya', approve: true });
    expect(r.refusal?.code).toBe('CONFLICT');
  });
});

describe('standing rules (procedural memory)', () => {
  it('ratification needs authority over the rule ceiling; a ratified rule then decides', async () => {
    const ctx = await ctxOn(base);
    const proposed = nw.story.proposedRule!;
    expect((await ratifyRule(ctx, proposed, 'p-jordan')).ok).toBe(false);
    expect((await ratifyRule(ctx, proposed, 'p-kofi')).ok).toBe(true);
    const rules = await listRules(ctx.db, NOW);
    expect(rules.find((r) => r.id === proposed)?.status).toBe('ratified');
    const skill = renderSkill('Northwind Cloud', rules, NOW);
    expect(skill).toMatch(/^---\nname: northwind-cloud-exception-desk/);
    expect(skill).toContain('Ratified by Kofi Mensah');
  });

  it('three good-law approvals of one shape propose a rule', async () => {
    const ctx = await ctxOn(base);
    const created = await proposeRules(ctx);
    expect(created.length).toBeGreaterThan(0);
    const rules = await listRules(ctx.db, NOW);
    for (const id of created) expect(rules.find((r) => r.id === id)!.basis.length).toBeGreaterThanOrEqual(3);
  });

  it('overturning a basis decision quarantines the rule and turns its followers yellow', async () => {
    const ctx = await ctxOn(base);
    const rule = nw.rules.find((r) => r.id === nw.story.ratifiedRule)!;
    const before = await flagsAt(ctx.db, NOW);
    const res = await overturnDecision(ctx, rule.derivedFrom[0]!, 'p-daniel', 'Audit: discount was granted without a signed multi-year order form.');
    expect(res.ok).toBe(true);
    expect(res.quarantined).toContain(rule.id);
    const after = await flagsAt(ctx.db, NOW + 2);
    expect(after[rule.derivedFrom[0]!]!.flag).toBe('red');
    expect(res.affected.some((id) => before[id]?.flag === 'green' && after[id]?.flag === 'yellow')).toBe(true);
    const v = await decide({ ...ctx, clock: { now: () => NOW + 3 } }, inbox('in-multiyear'));
    expect(v.basis).not.toBe('rule');
    expect((await verifyLedger(ctx.db, { deep: true })).ok).toBe(true);
  });
});

describe('knowledge currency', () => {
  it('policy impact runs on a copy: flags flip, autonomy drops, live graph untouched', async () => {
    const ctx = await ctxOn(base);
    const admin = await adminClient();
    const draft = await draftFromCurrent(ctx, 'discounts');
    draft.clauses = draft.clauses.map((c) => (c.key === '§2.4' ? { ...c, text: 'No discount above 20% off list.', rule: { ...c.rule, value: 20 } } : c));
    const before = await flagsAt(ctx.db, NOW);
    const report = await policyImpact(admin, ctx, draft, { replay: 12 });
    expect(report.becameRed).toBeGreaterThan(0);
    expect(report.autonomy.after).toBeLessThanOrEqual(report.autonomy.before);
    expect(await flagsAt(ctx.db, NOW)).toEqual(before);
    expect((await admin.list()).includes(report.whatIfGraph)).toBe(false);
  });

  it('adopting a version supersedes precedent live and is ledgered', async () => {
    const ctx = await ctxOn(base);
    const draft = await draftFromCurrent(ctx, 'discounts');
    draft.clauses = draft.clauses.map((c) => (c.key === '§2.4' ? { ...c, text: 'No discount above 20% off list.', rule: { ...c.rule, value: 20 } } : c));
    const res = await adoptPolicy(ctx, draft);
    expect(res.version).toBe(3);
    const flags = await flagsAt(ctx.db, NOW + 1);
    expect(flags[nw.story.supersededDiscount!]!.flag).toBe('red');
    expect((await verifyLedger(ctx.db)).ok).toBe(true);
  });

  it('a departure removes the delegation it backed, but past decisions stay good law', async () => {
    const ctx = await ctxOn(base);
    const before = await flagsAt(ctx.db, NOW);
    const ok = await decide(ctx, { ...inbox('in-terms-45'), dryRun: true });
    expect(ok.outcome).toBe('approved');
    await departPerson(ctx, 'p-grace');
    const after = await flagsAt(ctx.db, NOW + 1);
    const graces = nw.decisions.filter((d) => d.madeBy === 'p-grace' || d.onAuthorityOf === 'p-grace');
    expect(graces.length).toBeGreaterThan(0);
    for (const d of graces) expect(after[d.id]!.flag).toBe(before[d.id]!.flag);
    const v = await decide({ ...ctx, clock: { now: () => NOW + 2 } }, { ...inbox('in-terms-45'), dryRun: true });
    expect(v.outcome).toBe('escalated');
    expect(v.refusal?.code).toBe('NO_DELEGATION');
  });
});
