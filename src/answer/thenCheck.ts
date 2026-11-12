// "Then" guard for the free-text path (turns without a code-rendered comparison). A value in a
// Then/Before column must be a stored answer assertion for THAT row's item. A number that merely
// appears somewhere in memory is not enough, and a source fetched today never establishes a past
// value: a cited source counts only as a historical market fact, and only if it was published on or
// before the anchor date. Anything else is reconstruction, so the cell becomes "not recorded" and a
// verdict on that row is withdrawn. Runs BEFORE auto-citation, so code never adds the citation
// that would excuse an invented value.

import { cleanText } from '../memory/parseClaims.js';
import type { Evidence } from '../search/postprocess.js';
import { valueAppearsIn } from '../verify/diff.js';
import { entityMentioned } from '../verify/support.js';

const THEN_HEADER = /\b(then|before|previous(ly)?|earlier|was|old|stored|recorded)\b/i;
const NOW_HEADER = /\b(now|today|current(ly)?|latest|after|new)\b/i;
const STATUS_HEADER = /\b(status|change[ds]?|verdict|result|label)\b/i;
const MONEY = /(?:US\$|\$|€|£|₹)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR)\b/g;
const SEPARATOR = /^\s*\|?\s*:?-{2,}/;
const VERDICT = /\b(unchanged|no change|not changed|same|changed|increased|decreased|went (up|down))\b/i;

const splitRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');

export interface ThenCheck {
  text: string;
  replaced: number;
}

export interface RecordedValue {
  entity: string;
  value: string;
}

/**
 * @param recorded  the stored answer assertions of the recalled turns (entity + value)
 * @param evidence  this turn's sources
 * @param anchor    YYYY-MM-DD the "Then" refers to; a cited source must be published on or before it
 */
export function checkThenValues(answer: string, recorded: RecordedValue[], evidence: Evidence[], anchor?: string | null): ThenCheck {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const lines = answer.split('\n');
  let replaced = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|') || !SEPARATOR.test(lines[i + 1])) continue;
    const header = splitRow(lines[i]).map(cleanText);
    const thenCol = header.findIndex((h) => THEN_HEADER.test(h) && !NOW_HEADER.test(h));
    const isReport = thenCol > 0 && header.some((h, k) => k !== thenCol && (NOW_HEADER.test(h) || STATUS_HEADER.test(h)));
    if (!isReport) continue;
    const statusCol = header.findIndex((h, k) => k !== thenCol && STATUS_HEADER.test(h));
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const cells = splitRow(lines[j]);
      const cell = cells[thenCol] ?? '';
      const values = cell.match(MONEY) ?? [];
      if (!values.length) continue;
      const item = cleanText(cells.slice(0, thenCol).join(' '));
      const cited = [...cell.matchAll(/\[(S\d+)\]/g)].map((m) => byId.get(m[1])).filter((e): e is Evidence => !!e);
      const historical = (e: Evidence) => !!e.publishedAt && (anchor ? e.publishedAt <= anchor : true);
      const known = values.every(
        (v) =>
          recorded.some((r) => valueAppearsIn(v, r.value) && (entityMentioned(r.entity, item) || entityMentioned(item, r.entity))) ||
          cited.some((e) => historical(e) && valueAppearsIn(v, `${e.title}\n${e.excerpt}`)),
      );
      if (known) continue;
      cells[thenCol] = ' not recorded ';
      if (statusCol >= 0 && VERDICT.test(cells[statusCol] ?? '')) cells[statusCol] = " Can't compare (no earlier value recorded) ";
      lines[j] = `|${cells.join('|')}|`;
      replaced++;
    }
  }
  return { text: lines.join('\n'), replaced };
}
