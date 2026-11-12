// Consistency with what we said before, in code. When the user repeats a question, every price in
// the new answer is matched against the stored assertions of the earlier answer (same product, same
// plan, same attribute); a different value is surfaced as a note, whatever the model wrote.
// Live regression: "Shortlist 3 CRMs" asked twice gave HubSpot Starter $7, then $45, silently.

import type { ClaimRow } from '../memory/db.js';
import { parseClaims } from '../memory/parseClaims.js';
import { sectionTokens } from '../search/postprocess.js';
import { attrKey } from '../verify/reverify.js';
import { joinValue, parseMoney, sameAmount } from '../verify/diff.js';
import { entityMentioned } from '../verify/support.js';

export interface Inconsistency {
  entity: string;
  plan: string | null;
  attribute: string;
  then: string;
  now: string;
}

const GENERIC = new Set(['plan', 'tier', 'edition', 'package', 'the', 'paid', 'optional', 'recommended', 'per', 'user', 'seat', 'month']);

/** First distinguishing word of a plan ("Starter (paid) – optional …" → "starter"). */
function planKey(plan: string | null, entity: string): string | null {
  if (!plan) return null;
  const own = new Set(sectionTokens(entity));
  return sectionTokens(plan).find((w) => !own.has(w) && !GENERIC.has(w) && !/^\d/.test(w)) ?? null;
}

/**
 * Looser than the re-check comparison on purpose: this only asks "did we just give a different
 * number for the same thing?". A unit/period stated on one side only is not a reason to stay silent,
 * but two different stated bases are (per GB vs per hour are different prices, not a contradiction).
 */
function differs(then: string, now: string): boolean {
  const a = parseMoney(then);
  const b = parseMoney(now);
  if (!a || !b) return false;
  if (a.free && b.free) return false;
  if (!a.free && !b.free && a.currency !== b.currency && a.currency !== 'UNKNOWN' && b.currency !== 'UNKNOWN') return false;
  if (a.basis && b.basis && a.basis !== b.basis) return false;
  if (a.period !== 'none' && b.period !== 'none' && a.period !== b.period) return false;
  return a.free !== b.free || !sameAmount(a, b);
}

export function inconsistencies(answer: string, earlier: ClaimRow[]): Inconsistency[] {
  const before = earlier.filter((c) => (c.kind ?? 'price') === 'price' && c.status !== 'estimate');
  const out: Inconsistency[] = [];
  const seen = new Set<string>();
  for (const n of parseClaims(answer)) {
    if (n.approximate) continue;
    for (const e of before) {
      if (!(entityMentioned(e.entity, n.entity) || entityMentioned(n.entity, e.entity))) continue;
      if (planKey(e.plan, e.entity) !== planKey(n.plan, n.entity)) continue;
      if (attrKey(e.attribute) !== attrKey(n.attribute)) continue;
      const then = joinValue(e);
      const now = joinValue(n);
      if (!differs(then, now)) continue;
      const key = `${e.entity}|${e.plan}|${e.attribute}|${now}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ entity: e.entity, plan: e.plan, attribute: e.attribute, then, now });
    }
  }
  return out;
}
