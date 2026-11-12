// Auto-cite in code: when the model states a price in a table row (or a "**Product – plan: $X**"
// line) without an [Sn], attach the citation IF code can prove which retrieved source states that
// value for that product. Anything unprovable stays uncited (and is flagged by the claim check).

import { COMPUTED_HEADER, cleanText } from '../memory/parseClaims.js';
import type { Evidence } from '../search/postprocess.js';
import { supportedBy } from '../verify/support.js';

const MONEY = /(?:US\$|\$|€|£|₹)\s?\d[\d,]*(?:\.\d+)?/;
const CITE = /\[S\d+\]/;

function findSource(value: string, entity: string, evidence: Evidence[]): string | null {
  const official = evidence.filter((e) => e.tier === 'official');
  for (const pool of [official, evidence]) for (const e of pool) if (supportedBy(value, entity, e).ok) return e.id;
  return null;
}

export function autoCite(answer: string, evidence: Evidence[]): { text: string; added: number } {
  if (!evidence.length) return { text: answer, added: 0 };
  const lines = answer.split('\n');
  let added = 0;
  let header: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t.startsWith('|')) {
      const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|');
      if (lines[i + 1] && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        header = cells.map(cleanText);
        continue;
      }
      if (/^\s*\|?\s*:?-{2,}/.test(t) || CITE.test(t)) continue;
      const entity = cleanText(cells[0] ?? '');
      if (!entity) continue;
      let changed = false;
      for (let k = 1; k < cells.length; k++) {
        if (header && COMPUTED_HEADER.test(header[k] ?? '')) continue;
        const m = MONEY.exec(cells[k]);
        if (!m) continue;
        const id = findSource(m[0].replace(/\s+/g, ''), entity, evidence);
        if (id) {
          cells[k] = `${cells[k].trimEnd()} [${id}] `;
          changed = true;
          added++;
        }
      }
      if (changed) lines[i] = `|${cells.join('|')}|`;
      continue;
    }
    header = null;
    // "**Supabase – Pro plan = $25 / month** – …" without a citation on the line.
    const lead = /^(?:[-*]\s+)?\*\*([^*]+)\*\*/.exec(t);
    if (lead && !CITE.test(t)) {
      const m = MONEY.exec(lead[1]);
      if (!m) continue;
      const entity = cleanText(lead[1].slice(0, m.index)).split(/\s+[–—-]\s+|:\s+/)[0].replace(/[=:≈~\s]+$/, '');
      const id = entity ? findSource(m[0].replace(/\s+/g, ''), entity, evidence) : null;
      if (id) {
        lines[i] = `${line.trimEnd()} [${id}]`;
        added++;
      }
    }
  }
  return { text: lines.join('\n'), added };
}
