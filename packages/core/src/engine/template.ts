import type { PolicyId, Verdict } from './types.ts';

export function fmtValue(policy: PolicyId | null, v: number | null): string {
  if (v == null) return '—';
  if (policy === 'discounts') return `${v}%`;
  if (policy === 'payment_terms') return `Net-${v}`;
  return `$${v.toLocaleString('en-US')}`;
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Deterministic explanation built only from the verdict. Always available; the model's text must beat a gate to replace it. */
export function templateExplanation(v: Verdict): string {
  const acc = v.account?.name ?? v.intake.accountName ?? 'the account';
  const ask = fmtValue(v.policyId, v.requested);
  const parts: string[] = [];
  switch (v.outcome) {
    case 'not_in_graph':
      return `"${v.intake.accountName ?? '(no account named)'}" is not in the graph, so there is nothing to decide on. No action taken.`;
    case 'needs_info':
      return `The request is missing ${v.refusal?.detail ?? 'required fields'}. No action taken.`;
    case 'denied':
      if (v.limitViolations.length) {
        const c = v.limitViolations[0]!;
        parts.push(`Denied ${ask} for ${acc}: policy ${v.policyVersionId} ${c.key} forbids it${c.text ? ` ("${c.text}")` : ''}.`);
      } else parts.push(`Denied ${ask} for ${acc}${v.refusal ? `: ${v.refusal.detail}` : ''}.`);
      break;
    case 'approved':
      if (v.basis === 'routine') parts.push(`Approved ${ask} for ${acc}: inside the routine envelope of ${v.policyVersionId}.`);
      else if (v.basis === 'rule') parts.push(`Approved ${ask} for ${acc} under standing rule "${v.rule?.text}".`);
      else {
        const c = v.citations[0];
        parts.push(`Approved ${ask} for ${acc} on precedent: ${c ? `${c.account} (${date(c.at)}, ${fmtValue(v.policyId, c.value)}, decided by ${c.madeBy})` : '—'} is still good law and covers this request.`);
      }
      if (v.delegation) parts.push(`Authority: ${v.delegation.name}'s delegation (up to ${fmtValue(v.policyId, v.delegation.cap)}).`);
      break;
    case 'counter': {
      const c = v.citations[0];
      parts.push(`Counter-offer for ${acc}: ${fmtValue(v.policyId, v.value)} instead of ${ask}. The strongest good-law precedent, ${c ? `${c.account} (${date(c.at)})` : '—'}, supports up to ${fmtValue(v.policyId, v.value)}.`);
      break;
    }
    case 'escalated': {
      const why = v.refusal?.detail ?? 'no good-law precedent covers it';
      parts.push(`Escalated ${ask} for ${acc}: ${why}.`);
      if (v.route) parts.push(`Routed to ${v.route.name} (authority up to ${fmtValue(v.policyId, v.route.cap)}${v.route.hops ? `, ${v.route.hops} reporting hop${v.route.hops > 1 ? 's' : ''} away` : ''}).`);
      break;
    }
  }
  const bad = v.candidates.filter((c) => c.covers && c.standing.flag !== 'green');
  if (bad.length && v.outcome !== 'denied') {
    const b = bad[0]!;
    parts.push(`Not relied on: ${b.account} (${date(b.at)}) — ${b.standing.flag === 'red' ? 'no longer good law' : 'rests on a precedent that is no longer good law'} (${b.standing.reasons.map((r) => r.code).join(', ')}).`);
  }
  if (v.ignoredClaims.length) parts.push(`Ignored unverifiable claim: "${v.ignoredClaims[0]}".`);
  return parts.join(' ');
}

/** Names, numbers and ids the explanation may mention: everything in the verdict, nothing else. */
export function allowedMentions(v: Verdict, extra: string[] = []): string[] {
  const out = new Set<string>(extra);
  const add = (s: string | null | undefined) => s && out.add(s);
  add(v.account?.name);
  add(v.account?.ownerName);
  add(v.delegation?.name);
  add(v.route?.name);
  for (const n of v.route?.pathNames ?? []) add(n);
  for (const c of [...v.citations, ...v.candidates]) {
    add(c.account);
    add(c.madeBy);
  }
  add(v.policyVersionId);
  add(v.rule?.text);
  return [...out];
}

const STOP = new Set([
  'Approved', 'Denied', 'Escalated', 'Counter', 'Routed', 'Authority', 'The', 'This', 'No', 'Not', 'Policy', 'Refund', 'Discount',
  'Payment', 'Terms', 'Net', 'Ignored', 'Standing', 'Under', 'Because', 'However', 'It', 'A', 'An', 'Good', 'Law', 'Overruling', 'Risk',
  'Support', 'Renewals', 'Billing', 'Agent', 'VP', 'CFO', 'CEO', 'Head', 'Lead', 'Customer', 'Success', 'Finance', 'Sales', 'Director',
]);

/**
 * The explanation gate: every capitalised multi-word name and every number in the text must come from
 * the verdict. If the model mentions anything else (a person, an account, an amount), its text is rejected.
 */
export function gateExplanation(text: string, v: Verdict, allowed: string[]): { ok: boolean; offending: string[] } {
  const offending: string[] = [];
  const allowedLower = allowed.map((a) => a.toLowerCase());
  const names = text.match(/\b[A-Z][a-zA-Z'’-]+(?:\s+(?:&\s+)?[A-Z][a-zA-Z'’-]+)+/g) ?? [];
  for (const n of names) {
    const words = n.split(/\s+/).filter((w) => !STOP.has(w));
    if (words.length < 2) continue;
    const cand = words.join(' ').toLowerCase();
    if (!allowedLower.some((a) => a.includes(cand) || cand.includes(a))) offending.push(n);
  }
  const nums = new Set<number>();
  const pushNum = (x: number | null | undefined) => x != null && nums.add(x);
  pushNum(v.requested);
  pushNum(v.value);
  pushNum(v.delegation?.cap);
  pushNum(v.route?.cap);
  pushNum(v.route?.hops);
  pushNum(v.budget?.remaining);
  pushNum(v.budget?.cap);
  pushNum(v.intake.days);
  for (const c of [...v.citations, ...v.candidates]) {
    pushNum(c.value);
    pushNum(c.days);
    pushNum(new Date(c.at).getUTCFullYear());
    pushNum(new Date(c.at).getUTCDate());
  }
  for (const h of [...v.limitViolations, ...v.defaultViolations]) if (typeof h.value === 'number') pushNum(h.value);
  const pv = v.policyVersionId?.match(/v(\d+)/);
  if (pv) pushNum(Number(pv[1]));
  for (const m of text.matchAll(/\$?\b(\d[\d,]*(?:\.\d+)?)\b/g)) {
    const n = Number(m[1]!.replace(/,/g, ''));
    if (n <= 12 && !m[0].startsWith('$')) continue; // small counts, months, clause numbers
    if (!nums.has(n)) offending.push(m[0]);
  }
  return { ok: offending.length === 0, offending };
}
