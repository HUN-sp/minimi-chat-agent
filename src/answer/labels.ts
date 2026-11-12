// Label guard in code: "Confirmed" means "an official source in this turn states it".
// A row/line that says Confirmed must cite an official source on the same line; otherwise the
// label is downgraded (Reported if it cites a third-party source, Unverified if it cites nothing).
// Two more rules (live regressions):
//   • an official page published over six months ago doesn't confirm a CURRENT price (HubSpot's 2018
//     page cited for "Nov 2026 pricing");
//   • a currency conversion or estimate on the line ("₹1,400 ≈ $16") is ours, not the source's, so
//     the label says so instead of presenting the converted figure as confirmed.

import type { Evidence } from '../search/postprocess.js';
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
