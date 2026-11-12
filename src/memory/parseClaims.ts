// Deterministic claim extraction from the assistant's own answer (no LLM).
// The system prompt makes answers structured: comparison tables, or "**Product – plan**" lines
// followed by "- Label: $X … [S2]" bullets. We parse those shapes:
//   • tables: first column = product (or attribute, when the header says Feature/Item/…),
//     headers name the attribute/plan, money cells are values, [Sn] in the cell/row is the source;
//   • labelled lines: "**Supabase – Pro plan = $25 / month** … [S6]" and bullets under a product line.
// Prose that fits neither shape is left to the LLM fallback in extract.ts.

export interface ParsedClaim {
  entity: string;
  plan: string | null;
  attribute: string;
  value: string; // "$0.30"
  unit: string | null; // "per 1M tokens", "per seat"
  period: string | null; // "month" | "year" | "hour" | null
  sources: string[]; // ["S2"]
  approximate: boolean; // "≈ $20", "about $15": an estimate, not a list price
}

const MONEY = /(?:US\$|\$|€|£|₹)\s?\d[\d,]*(?:\.\d+)?(?:\s?[kK]\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR)\b/g;
const MONEY_ONE = new RegExp(MONEY.source);
const hasMoney = (s: string) => MONEY_ONE.test(s);
const CITE = /\[(S\d+)\]/g;
const APPROX = /(≈|~|\babout\b|\baround\b|\broughly\b|\bapprox|\bestimate|\btypical|\bup to\b)/i;
const ATTRIBUTE_ROW_HEADER = /\b(feature|item|metric|attribute|component|resource|usage|type|line item|charge|dimension|token|what)\b/i;
/** Row labels that name a billable dimension, not a product ("Input (text)", "Storage", "Compute"). */
const ATTRIBUTE_LABEL = /^(input|output|storage|compute|egress|bandwidth|data transfer|requests?|context|cach(e|ed|ing)|audio|image|video|text|branch(es)?|seats?|base fee|platform fee|support|backups?|grounding|batch|thinking)\b/i;

/** Unicode hyphens and no-break spaces to ASCII, so "CU‑hour" (U+2011) parses like "CU-hour". */
export function normalizeText(s: string): string {
  return s.replace(/[\u2010\u2011\u2012\u2212]/g, '-').replace(/[\u00a0\u202f\u2009]/g, ' ');
}
const PLAN_HEADER = /\b(plan|tier|edition|instance|package|model)\b/i;
const SOURCE_HEADER = /\b(source|sources|citation|ref)\b/i;
/** Columns holding the model's own arithmetic ("20 seats", "Total annual cost"), not source facts. */
export const COMPUTED_HEADER = /\b(total|annual cost|yearly cost|team|for \d+|\d+\s*(seats|users|people))\b|×/i;
const NOTE_HEADER = /\b(note|notes|includes?|included|what.?s included|features?|best for|why|comment|limits?|details?|pros|cons|status|verdict|label)\b/i;

const THEN_NOW_HEADER = /\b(then|now|before|after|previous(ly)?|earlier|today|was|status)\b/i;
/** Section labels the parser must not mistake for a product ("**Current verification**", "**Verdict:**"). */
const NOT_A_PRODUCT = /^(verdict|note|notes|summary|sources?|bottom line|tl;dr|recommendation|current|verification|comparison|update|updates|changes?|what|quick|result|results|overview|pricing|prices|answer|details|why|how|key|next steps?|earlier|other|interpretation|unable|coverage|announcements?|correction|today)\b/i;

export function cleanText(s: string): string {
  return s
    .replace(CITE, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function citations(s: string): string[] {
  return [...new Set([...s.matchAll(CITE)].map((m) => m[1]))];
}

function slug(s: string): string {
  return (
    cleanText(s)
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/\b(per|in|usd|the|a|an|of|price|cost)\b/g, (w) => (w === 'price' || w === 'cost' ? w : ' '))
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'price'
  );
}

/** Unit and billing period from the text around a price ("$9 per seat/month", header "Price per seat"). */
export function describeUnit(text: string): { unit: string | null; period: string | null } {
  const t = text.toLowerCase();
  let unit: string | null = null;
  if (/(1\s?m|million|mtok)\b.*tokens?|per\s?1\s?m\b|\/\s?1\s?m\b/.test(t)) unit = /output/.test(t) ? 'per 1M output tokens' : /input/.test(t) ? 'per 1M input tokens' : 'per 1M tokens';
  else if (/\b(seat|user|member|agent|licen[cs]e)s?\b/.test(t)) unit = 'per seat';
  else if (/cu[- ]?(hour|hr)/.test(t)) unit = 'per CU-hour';
  else if (/gb[- ]?(month|mo)\b/.test(t)) unit = 'per GB-month';
  else if (/\bper gb\b|\/\s?gb\b/.test(t)) unit = 'per GB';
  else if (/\bper (image|request|call|1,?000 requests?)\b/.test(t)) unit = t.match(/\bper (image|request|call|1,?000 requests?)\b/)![0];
  let period: string | null = null;
  // "per GB-month" is a unit, not a monthly billing period.
  const p = t.replace(/gb[- ]?(month|mo)\b/g, ' ');
  if (/(\/|\bper\b|\ba\b)\s*(mo|mon|month)\b|\bmonthly\b|\/\s?mo\b|\bmonth\b/.test(p)) period = 'month';
  else if (/(\/|\bper\b)\s*(yr|year)\b|\byearly\b|\bper annum\b/.test(t)) period = 'year';
  else if (/(\/|\bper\b)\s*(hr|hour)\b|\bhourly\b/.test(t) && !/cu[- ]?(hour|hr)/.test(t)) period = 'hour';
  return { unit, period };
}

/** Split "Supabase – Pro plan" / "HubSpot: Sales Hub Starter" into entity + plan. */
function splitEntityPlan(label: string): { entity: string; plan: string | null } {
  const l = cleanText(label).replace(/[=:≈~\s]+$/, '').trim();
  const parts = l.split(/\s+[–—-]\s+|:\s+|\s+\|\s+/);
  const entity = parts[0].replace(/\s*\(.*\)\s*$/, '').trim();
  const plan = parts.slice(1).join(' – ').trim() || null;
  return { entity, plan };
}

function moneyIn(cell: string): { value: string; after: string; before: string }[] {
  const out: { value: string; after: string; before: string }[] = [];
  for (const m of cell.matchAll(MONEY)) {
    const i = m.index!;
    // The unit text after a price ends at the next separator or price ("$0.14 /CU-hour · $0.35 / GB-month").
    const after = cell
      .slice(i + m[0].length, i + m[0].length + 48)
      .split(/[·;|]|(?=[$€£₹])/)[0]
      .replace(/^[\s,*]+/, '');
    out.push({ value: m[0].replace(/\s+/g, ''), after, before: cell.slice(Math.max(0, i - 24), i) });
  }
  return out;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function parseTables(lines: string[], contextAt: (i: number) => { entity: string; plan: string | null } | null): ParsedClaim[] {
  const out: ParsedClaim[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|') || !lines[i + 1] || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue;
    const header = splitRow(lines[i]).map(cleanText);
    // A Then-vs-Now table is the re-check report (the old values came from memory, the new ones are
    // in the diff), not a fresh statement of prices: skip it.
    if (header.filter((h) => THEN_NOW_HEADER.test(h)).length >= 2) continue;
    const ctx = contextAt(i);
    let end = i + 2;
    while (end < lines.length && lines[end].trim().startsWith('|')) end++;
    const body = lines.slice(i + 2, end).map(splitRow);
    const attrLabels = body.filter((r) => ATTRIBUTE_LABEL.test(cleanText(r[0] ?? ''))).length;
    const labelIsAttribute = ATTRIBUTE_ROW_HEADER.test(header[0] ?? '') || (body.length > 0 && attrLabels * 2 >= body.length);
    // A plan column names plans; a column holding prices ("Paid tier (per 1M tokens)") is a value column.
    const planCol = header.findIndex((h, k) => k > 0 && PLAN_HEADER.test(h) && !/price|cost|per\b/i.test(h) && !body.some((r) => hasMoney(r[k] ?? '')));
    const sourceCol = header.findIndex((h) => SOURCE_HEADER.test(h));
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const cells = splitRow(lines[j]);
      const rowLabel = cleanText(cells[0] ?? '');
      if (!rowLabel || hasMoney(rowLabel)) continue;
      const rowCites = citations(lines[j]);
      for (let k = 1; k < cells.length; k++) {
        if (k === planCol || k === sourceCol || NOTE_HEADER.test(header[k] ?? '') || COMPUTED_HEADER.test(header[k] ?? '')) continue;
        const ms = moneyIn(cells[k]);
        if (!ms.length) continue;
        const cellCites = citations(cells[k]);
        const sources = cellCites.length ? cellCites : sourceCol >= 0 ? citations(cells[sourceCol] ?? '').concat(rowCites).filter((v, x, arr) => arr.indexOf(v) === x) : rowCites;
        let entity: string;
        let plan: string | null;
        let base: string;
        if (labelIsAttribute) {
          if (!ctx) continue; // attribute rows need a product from the heading above the table
          entity = ctx.entity;
          plan = ctx.plan ?? (/(price|cost)/i.test(header[k]) ? null : cleanText(header[k]) || null);
          base = slug(rowLabel);
        } else {
          const ep = splitEntityPlan(rowLabel);
          entity = ep.entity;
          plan = planCol >= 0 ? cleanText(cells[planCol] ?? '') || ep.plan : ep.plan;
          const h = header[k] ?? '';
          base = /^(price|cost|pricing|monthly cost|price per seat|monthly price)/i.test(cleanText(h)) || !h ? 'price' : slug(h);
        }
        // A cell can hold several prices ("$0.14 /CU-hour · $0.35 / GB-month", "$0.30 (text) $1.00 (audio)"):
        // one claim each, named by its own unit or qualifier. The header supplies a unit the cell doesn't state.
        ms.forEach((m, idx) => {
          const own = describeUnit(m.after);
          const hdr = describeUnit(header[k] ?? '');
          const unit = own.unit ?? hdr.unit;
          const period = own.period ?? hdr.period;
          let attribute = base;
          if (ms.length > 1) {
            const qual = slug(
              m.after
                .replace(/<=|≤/g, ' le ')
                .replace(/>=|≥/g, ' ge ')
                .replace(/</g, ' lt ')
                .replace(/>/g, ' gt ')
                .replace(/[()]/g, ' ')
                .slice(0, 36),
            );
            attribute = `${base}_${own.unit ? slug(own.unit) : qual !== 'price' ? qual : idx + 1}`;
          }
          out.push({ entity, plan, attribute, value: m.value, unit, period, sources, approximate: APPROX.test(m.before + (idx === 0 ? cells[k] : '')) });
        });
      }
    }
    i = j - 1;
  }
  return out;
}

/**
 * The list of products an answer laid out (a shortlist / comparison): first column of the first
 * product table, or bold names in a numbered list. Needs ≥2 members to count as a set.
 */
export function parseEntityList(answer: string): string[] {
  const lines = normalizeText(answer).split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|') || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue;
    const header = splitRow(lines[i]).map(cleanText);
    if (ATTRIBUTE_ROW_HEADER.test(header[0] ?? '')) continue;
    if (ATTRIBUTE_LABEL.test(cleanText(splitRow(lines[i + 2] ?? '')[0] ?? ''))) continue;
    const names: string[] = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const n = splitEntityPlan(splitRow(lines[j])[0] ?? '').entity;
      if (n && !hasMoney(n) && n.length <= 40 && !names.includes(n)) names.push(n);
    }
    if (names.length >= 2) return names;
  }
  const numbered = [...answer.matchAll(/^\s*\d+[.)]\s+\*\*([^*]{2,40})\*\*/gm)].map((m) => splitEntityPlan(m[1]).entity);
  return numbered.length >= 2 ? [...new Set(numbered)] : [];
}

/** Words that start a question/sentence and get glued onto the first name ("Compare Neon"). */
const LIST_STARTERS = new Set(
  'what which how is are does do did should can could tell show give list compare between i we you our my the for about vs pricing price plans'.split(' '),
);
const NAME = String.raw`[A-Z][\w.+&-]*(?:\s+[A-Z0-9][\w.+&-]*){0,3}`;
const NAME_LIST = new RegExp(`${NAME}(?:\\s*,\\s*${NAME})*\\s*,?\\s+(?:and|or|vs\\.?|versus)\\s+${NAME}`, 'g');

/**
 * Named items the USER listed ("What do Neon, Supabase and AWS RDS charge?" → Neon, Supabase,
 * AWS RDS). Stored as the turn's entity set even when the answer fails, so a later "has any of
 * them changed?" still knows what "them" is.
 */
export function parseNameList(text: string): string[] {
  let best: string[] = [];
  for (const m of normalizeText(text).matchAll(NAME_LIST)) {
    const names = m[0]
      .split(/\s*,\s*|\s+(?:and|or|vs\.?|versus)\s+/)
      .map((n) => {
        const words = n.trim().split(/\s+/);
        while (words.length > 1 && LIST_STARTERS.has(words[0].toLowerCase())) words.shift();
        return words.join(' ').replace(/[.,]+$/, '');
      })
      .filter((n) => n.length >= 2 && n.length <= 40 && !LIST_STARTERS.has(n.toLowerCase()));
    const uniq = [...new Set(names)];
    if (uniq.length > best.length) best = uniq;
  }
  return best.length >= 2 ? best : [];
}

export function parseClaims(answer: string): ParsedClaim[] {
  const lines = normalizeText(answer).split('\n');
  // Product context from headings / bold lead lines without prices ("**Gemini 2.5 Flash** – Standard tier").
  const ctxByLine: ({ entity: string; plan: string | null } | null)[] = [];
  let ctx: { entity: string; plan: string | null } | null = null;
  // Markdown headings nest: "## Gemini 2.5 Flash" › "### Standard" is the Standard tier OF Gemini
  // 2.5 Flash, not a product called "Standard". Track the heading that set the product context.
  let productLevel: number | null = null;
  for (const line of lines) {
    const t = line.trim();
    const heading = /^(#{1,4})\s+(.+)$/.exec(t);
    const boldLead = /^\*\*([^*]+)\*\*(.*)$/.exec(t);
    if ((heading || boldLead) && !hasMoney(t)) {
      const label = heading ? heading[2] : `${boldLead![1]}${boldLead![2]}`;
      const level = heading ? heading[1].length : null;
      const ep = splitEntityPlan(label);
      if (level !== null && ctx && productLevel !== null && level > productLevel && ep.entity && !NOT_A_PRODUCT.test(ep.entity)) {
        ctx = { entity: ctx.entity, plan: cleanText(label).slice(0, 60) };
      } else if (ep.entity && ep.entity.length <= 60 && !NOT_A_PRODUCT.test(ep.entity)) {
        ctx = ep;
        productLevel = level;
      } else if (NOT_A_PRODUCT.test(ep.entity)) {
        ctx = null;
        productLevel = null;
      }
    }
    ctxByLine.push(ctx);
  }

  // Labelled lines first (their labels are the most specific), then tables (often a summary).
  const claims: ParsedClaim[] = [];

  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('|')) return;
    const ms = moneyIn(t);
    if (!ms.length) return;
    const sources = citations(t);
    // "**Supabase – Pro plan = $25 / month** …": entity+plan before the price, inside the bold lead.
    const lead = /^(?:[-*]\s+)?\*\*([^*]+)\*\*/.exec(t);
    if (lead && moneyIn(lead[1]).length) {
      const before = lead[1].slice(0, lead[1].search(MONEY_ONE));
      const ep = splitEntityPlan(before);
      if (ep.entity) {
        const m = moneyIn(lead[1])[0];
        claims.push({ ...ep, attribute: APPROX.test(before + m.after) ? 'estimated_cost' : 'price', value: m.value, ...describeUnit(m.after), sources, approximate: APPROX.test(before) });
        return;
      }
    }
    // "- Input: **$0.30 / 1M tokens** … [S2]" or "- Compute $0.14 per CU-hour [S3]" under a product context line.
    const bullet = /^[-*]\s+(?:\*\*)?([^:*$€£₹\d][^:*$€£₹]{1,40}?)(?:\*\*)?\s*(?::\s*|\s+(?=\**[$€£₹]))(.+)$/.exec(t);
    const c = ctxByLine[i];
    if (bullet && c) {
      const m = moneyIn(bullet[2])[0];
      if (!m) return;
      claims.push({ entity: c.entity, plan: c.plan, attribute: slug(bullet[1]), value: m.value, ...describeUnit(`${m.after} ${bullet[1]}`), sources, approximate: APPROX.test(m.before) });
    }
  });

  claims.push(...parseTables(lines, (i) => ctxByLine[i]));

  // One claim per (entity, plan, attribute), and one per (entity, attribute, value) so a price
  // repeated in a summary table with a shorter plan name isn't stored twice. First wins.
  const seen = new Set<string>();
  return claims.filter((c) => {
    const keys = [`${c.entity}|${c.plan}|${c.attribute}`, `${c.entity}|${c.attribute}|${c.value}`, `${c.entity}|${c.value}|${c.unit}`].map((k) => k.toLowerCase());
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
}
