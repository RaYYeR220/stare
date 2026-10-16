import { beforeAll, describe, expect, it } from 'vitest';
import { decide } from '../src/engine/decide.ts';
import { eraseSubject, naiveControl, redact, verifyCertificate } from '../src/erasure.ts';
import { verifyLedger } from '../src/ledger.ts';
import { adminClient } from './helpers.ts';
import { ctxOn, inbox, NOW, northwindBase, nw } from './northwind.ts';

let base: string;
beforeAll(async () => {
  base = await northwindBase('erase');
}, 120_000);

const subject = () => nw.story.erasureSubject!;

describe('forget with proof', () => {
  it('erases the subject everywhere, keeps the business record, and certifies it', async () => {
    const ctx = await ctxOn(base);
    // a live decision whose request names the subject ("Marta says ...")
    const live = await decide(ctx, inbox('in-acme-outage'));
    const cert = (await eraseSubject({ ...ctx, clock: { now: () => NOW + 10 } }, subject()))!;
    expect(cert.checks.filter((c) => !c.pass)).toEqual([]);
    expect(cert.verdict).toBe('ERASED');
    expect(cert.checks.map((c) => [c.id, c.pass])).toEqual([
      ['C1', true],
      ['C2', true],
      ['C3', true],
      ['C4', true],
    ]);
    expect(cert.counts.factsDeleted).toContain(nw.story.factErased);
    expect(cert.counts.factsRetained.map((f) => f.id)).toContain(nw.story.factRetained);
    expect(cert.counts.messagesErased).toBeGreaterThan(2);
    expect(verifyCertificate(cert)).toBe(true);

    // the business record survives: the decisions still exist, with their authority and citations
    const [old] = await ctx.db.ro<{ narrative: string; flag: string }>(
      'MATCH (d:Decision {id:$id}) RETURN d.narrative AS narrative, stare.standing(d, $now).flag AS flag',
      { id: nw.story.acmeRoutine, now: NOW + 20 },
    );
    expect(old!.narrative).toContain('[erased]');
    expect(old!.flag).toBe('green');
    const [hero] = await ctx.db.ro<{ grounded: string[] }>(
      'MATCH (d:Decision {id:$id})-[:GROUNDED_IN]->(g) RETURN collect(labels(g)[0]) AS grounded',
      { id: live.decisionId },
    );
    expect(hero!.grounded).toContain('Erasure');

    // the ledger still verifies, and the certificate itself is ledgered
    expect((await verifyLedger(ctx.db, { deep: true })).ok).toBe(true);
    const [entry] = await ctx.db.ro<{ payload: string }>(
      "MATCH (e:LedgerEntry {kind:'erasure'}) RETURN e.payload AS payload",
    );
    expect(JSON.parse(entry!.payload).certificateHash).toBe(cert.certificateHash);
  });

  it('negative control: deleting only the contact node is refused by the same checks', async () => {
    const ctx = await ctxOn(base);
    const control = await naiveControl(await adminClient(), ctx, subject());
    expect(control.verdict).toBe('REFUSED');
    const failed = control.checks.filter((c) => !c.pass).map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(['C1', 'C2', 'C3']));
    expect(control.checks.find((c) => c.id === 'C4')!.pass).toBe(true);
  });

  it('a first name shared with other contacts neither blocks the certificate nor touches them', async () => {
    const ctx = await ctxOn(base);
    const first = (n: string) => n.split(' ')[0]!;
    const subjectRow = nw.contacts.find((c) => c.id !== subject() && nw.contacts.some((o) => o.id !== c.id && first(o.name) === first(c.name)))!;
    const namesake = nw.contacts.find((o) => o.id !== subjectRow.id && first(o.name) === first(subjectRow.name))!;
    const cert = (await eraseSubject(ctx, subjectRow.id))!;
    expect(cert.checks.filter((c) => !c.pass)).toEqual([]);
    const [other] = await ctx.db.ro<{ name: string }>('MATCH (k:Contact {id:$id}) RETURN k.name AS name', { id: namesake.id });
    expect(other!.name).toBe(namesake.name);
  });

  it('a tampered certificate does not verify', async () => {
    const ctx = await ctxOn(base);
    const cert = (await eraseSubject(ctx, subject()))!;
    expect(verifyCertificate({ ...cert, counts: { ...cert.counts, messagesErased: 0 } })).toBe(false);
  });

  it('redaction is case-insensitive and longest-first', () => {
    expect(
      redact('Marta Lindqvist (marta.lindqvist@acme.example) said MARTA agreed', [
        'Marta Lindqvist',
        'marta.lindqvist@acme.example',
        'Marta',
      ]),
    ).toBe('[erased] ([erased]) said [erased] agreed');
  });
});
