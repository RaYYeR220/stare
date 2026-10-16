import type { Intake, PolicyId, Verdict } from './engine/types.ts';

export interface ParseHints {
  /** Policies the caller is allowed to file under. */
  policies: PolicyId[];
  reasons: Record<PolicyId, string[]>;
}

/** The only two things the language model does in Stare. Neither can change an outcome. */
export interface Llm {
  readonly model: string;
  parseRequest(text: string, hints: ParseHints): Promise<Intake>;
  explain(verdict: Verdict, allowedNames: string[]): Promise<string>;
}

export const REASONS: Record<PolicyId, string[]> = {
  refunds: ['outage', 'billing_error', 'churn_risk', 'duplicate_charge', 'goodwill'],
  discounts: ['competitive', 'multi_year', 'churn_risk', 'expansion', 'nonprofit'],
  payment_terms: ['procurement_cycle', 'public_sector', 'cash_flow', 'multi_year'],
};

const REASON_WORDS: Array<[RegExp, string]> = [
  [/outage|downtime|\bdown\b|incident|lost .* (hours|day)/i, 'outage'],
  [/double[- ]charged|duplicate charge|charged twice/i, 'duplicate_charge'],
  [/billing error|billed for|wrong price|invoice mistake|overcharged/i, 'billing_error'],
  [/goodwill|gesture/i, 'goodwill'],
  [/churn|walk at renewal|leave us|wobbling|at risk/i, 'churn_risk'],
  [/competitor|competitive|quote .* under|match/i, 'competitive'],
  [/multi[- ]?year|\b[23]-year|three-year|two-year/i, 'multi_year'],
  [/adding .* seats|expansion|more seats/i, 'expansion'],
  [/nonprofit|non-profit|foundation/i, 'nonprofit'],
  [/public sector|statutory|regulation|government/i, 'public_sector'],
  [/cash flow/i, 'cash_flow'],
  [/procurement|AP runs|pays (only )?on net|only pays/i, 'procurement_cycle'],
];

const CLAIMS: RegExp[] = [
  /\b(already|pre-?)\s*(signed off|approved)\b[^.]*/i,
  /\bignore\b[^.]*/i,
  /\bmark it approved\b[^.]*/i,
  /\b(CEO|VP|CFO|director)\b[^.]*\b(approved|signed off|ok'?d|pre-approved)\b[^.]*/i,
];

/**
 * Deterministic request parser (regular expressions). Used by the test suite and as the offline
 * mode when no model key is configured. It extracts the same fields as the model would.
 */
export class HeuristicLlm implements Llm {
  readonly model = 'heuristic';
  constructor(private knownAccounts: string[] = []) {}

  async parseRequest(text: string, hints: ParseHints): Promise<Intake> {
    let policyId: PolicyId | null = null;
    let value: number | null = null;
    const money = text.match(/\$\s?([\d,]+(?:\.\d+)?)/);
    const pct = text.match(/(\d{1,2})\s?%/);
    const net = text.match(/net[- ]?(\d{2,3})/i);
    if (net && hints.policies.includes('payment_terms')) {
      policyId = 'payment_terms';
      value = Number(net[1]);
    } else if (pct && /off|discount|list|renew/i.test(text) && hints.policies.includes('discounts')) {
      policyId = 'discounts';
      value = Number(pct[1]);
    } else if (money && hints.policies.includes('refunds')) {
      policyId = 'refunds';
      value = Number(money[1]!.replace(/,/g, ''));
    }
    const daysM = text.match(/(\d{1,3})\s+days?\b/i);
    const days = policyId === 'refunds' && daysM ? Number(daysM[1]) : null;
    let reason: string | null = null;
    if (policyId) {
      for (const [re, code] of REASON_WORDS) {
        if (re.test(text) && hints.reasons[policyId].includes(code)) {
          reason = code;
          break;
        }
      }
    }
    const lower = text.toLowerCase();
    let accountName = this.knownAccounts.filter((a) => lower.includes(a.toLowerCase())).sort((a, b) => b.length - a.length)[0] ?? null;
    if (!accountName) {
      const m = text.match(/^\s*(?:[A-Z][\w&'.-]*\s?){1,4}/);
      accountName = m ? m[0].trim().replace(/\s+(is|wants|has|will|needs|procurement|asks?)$/i, '') : null;
      if (accountName) accountName = accountName.replace(/[:,]$/, '');
    }
    const claims = CLAIMS.flatMap((re) => {
      const m = text.match(re);
      return m ? [m[0].trim()] : [];
    });
    return { policyId, accountName, value, days, reason, claims: [...new Set(claims)] };
  }

  async explain(): Promise<string> {
    throw new Error('heuristic mode has no model explanation');
  }
}
