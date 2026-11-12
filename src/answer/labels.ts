// Label guard in code: "Confirmed" means "an official source in this turn states it".
// A row/line that says Confirmed must cite an official source on the same line; otherwise the
// label is downgraded (Reported if it cites a third-party source, Unverified if it cites nothing).
// Two more rules (live regressions):
//   • an official page published over six months ago doesn't confirm a CURRENT price (HubSpot's 2018
//     page cited for "Nov 2026 pricing");
//   • a currency conversion or estimate on the line ("₹1,400 ≈ $16") is ours, not the source's, so
//     the label says so instead of presenting the converted figure as confirmed.

import type { Evidence } from '../search/postprocess.js';
import { valueAppearsIn } from '../verify/diff.js';
import { isStale } from './freshness.js';

// The model sometimes invents synonyms ("Verified"); they get the same rule as "Confirmed".
const CONFIRMED = /(\*\*)?\b(?:Confirmed|Verified)\b(\*\*)?/g;
const APPROX_MONEY = /(?:≈|~|\babout\b|\baround\b|\broughly\b|\bapprox\.?)\s*(?:US\$|\$|€|£|₹)\s?\d/i;

export function enforceLabels(text: string, evidence: Evidence[], today?: string): { text: string; downgraded: number } {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  let downgraded = 0;
  const lines = text.split('\n').map((line) => {
    if (!/\b(?:Confirmed|Verified)\b/.test(line)) return line;
    const cites = [...line.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]);
    const official = cites.map((id) => byId.get(id)).filter((e) => e?.tier === 'official');
    const current = official.filter((e) => !today || !isStale(e, today));
    if (current.length) {
      if (APPROX_MONEY.test(line) && !/our (?:conversion|estimate)/i.test(line)) {
        return line.replace(CONFIRMED, (_m, a, b) => `${a ?? ''}Confirmed${b ?? ''} (the ≈ figure is our conversion/estimate, not the source's)`);
      }
      return line;
    }
    downgraded++;
    if (official.length) {
      const d = official[0]!.publishedAt;
      return line.replace(CONFIRMED, (_m, a, b) => `${a ?? ''}Can't verify${b ?? ''} (vendor page dated ${d}, may be outdated)`);
    }
    const label = cites.length ? 'Reported' : 'Unverified (no source this turn)';
    return line.replace(CONFIRMED, (_m, a, b) => `${a ?? ''}${label}${b ?? ''}`);
  });
  return { text: lines.join('\n'), downgraded };
}

/**
 * Second half of the label rule: the cited page must not only be official and current, it must STATE
 * the value. The claim check found values the cited source doesn't state (`misses`); on any line that
 * shows one of them, cites that source and says "Confirmed", the label is replaced. Live regression:
 * "| Input tokens | $2.00 | Confirmed – ai.google.dev [S2] |" above "Not confirmed by the cited source:
 * … $2.00: S2 does not mention Gemini 2.5 Flash".
 */
export function markUnconfirmed(text: string, misses: { value: string; ids: string[] }[]): { text: string; downgraded: number } {
  if (!misses.length) return { text, downgraded: 0 };
  let downgraded = 0;
  const lines = text.split('\n').map((line) => {
    if (!/\b(?:Confirmed|Verified)\b/.test(line)) return line;
    const cites = new Set([...line.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]));
    const hit = misses.some((m) => (!m.ids.length || m.ids.some((id) => cites.has(id))) && valueAppearsIn(m.value, line));
    if (!hit) return line;
    downgraded++;
    return line.replace(CONFIRMED, (_m, a, b) => `${a ?? ''}Not confirmed${b ?? ''} (the cited source doesn't state this value)`);
  });
  return { text: lines.join('\n'), downgraded };
}
