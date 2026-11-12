// Citation grounding for statements that are NOT prices (prices have their own, stricter check).
// A cited row or sentence names things: projects, people, organisations, model names, counts. The
// model only ever saw the cited source's excerpt, so those names must be in that excerpt. When most
// of a statement's distinctive terms are absent from every source it cites, the statement did not
// come from that source: it was recalled from training data or invented, and the citation is
// decoration. Such statements are flagged to the user; nothing is silently rewritten.
//
// Live regression: "DeepMind 'Neural Transparency' project" cited to an MIT Media Lab page,
// "Anthropic circuit editing in Claude-2" cited to the Stanford AI100 report, ICLR papers cited to
// gptzero.me — all labelled "Reported", none flagged.

import { segments } from '../memory/assertions.js';
import { normalizeText } from '../memory/parseClaims.js';
import type { Evidence } from '../search/postprocess.js';
import { valueAppearsIn } from '../verify/diff.js';

export interface Ungrounded {
  label: string; // the start of the statement, for the user to find it
  ids: string[]; // the sources it cites
  missing: string[]; // distinctive terms none of those sources contain
  coverage: number; // % of the statement's content words found in the cited sources
}

const PROSE_STOP = new Set(
  `about above after again against their there these those which while would could should other another being where when what with from into than then this that have has had were was been
  also more most such only very some many much each every both onto over under between through during before including include includes using used new latest recent first second third
  shows show provides provide highlights highlight introduces introduced describes describe allows allow makes make helps help based across within without toward towards still already
  now today report reports research model models system systems safety work tools tool`.split(/\s+/),
);

const ABSENCE =
  /\b(?:no (?:current|official|specific|public|recent|relevant)\b|not (?:verified|found|listed|available|stated|published)\b|could(?:n['’]t| not) (?:find|verify|locate|confirm)|can['’]t verify|cannot verify|unable to|did(?:n['’]t| not) find|not verify)/i;

/** Lower-case content words (≥ 5 letters, crude stem): the vocabulary of a statement. */
function contentWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\[s\d+\]/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length >= 5 && !PROSE_STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s|ly)$/, ''));
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const DAYS = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun';
const COMMON = new Set(
  `the this that these those there their they then than and but for with from into onto over under about after before during while when where which what who whom whose why how
  its our your you we he she his her him them not can't cannot could would should will may might must also only just even still very more most less least many much some any all each
  every both either neither one two three four five six seven eight nine ten first second third new recent latest current today yesterday tomorrow now here status source sources
  note notes summary interpretation confirmed reported unverified verify verified can't key why work tool tools project projects paper papers report reports research release
  released launch launched announced introduces introduced describes highlights notable data model models system systems team teams lab labs center centre program programme
  institute university company companies government state national international global annual quarterly monthly weekly daily official secondary reputable fetched published
  checked shown above below table row column item items detail details overview context background result results finding findings development developments key takeaway
  takeaways what's whats bottom line next steps step yes no ok llm llms api apis ml saas ceo cto faq`.split(/\s+/),
);

/** Lower-case, unicode dashes/quotes folded, punctuation to spaces. */
const fold = (s: string) =>
  normalizeText(s)
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/[^a-z0-9.%+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Distinctive terms a source would have to contain for this statement to come from it. */
export function salientTerms(text: string): string[] {
  const s = normalizeText(text)
    .replace(/\[S\d+\]/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(new RegExp(`\\b(?:${DAYS}),?\\s+`, 'g'), ' ')
    .replace(new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})\\.?(?:\\s+\\d{4})?\\b|\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:,?\\s+\\d{4})?\\b|\\b(?:${MONTHS})\\.?\\s+\\d{4}\\b`, 'g'), ' ')
    .replace(/(?:US\$|\$|€|£|₹)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:[kKMB]|million|billion))?/g, ' '); // prices: checked elsewhere
  const terms = new Set<string>();
  // Pieces: table cells and sentences. A capitalised first word of a piece is not evidence of a name.
  for (const piece of s.split(/\s*\|\s*|(?<=[.!?:;])\s+|\s+[–—-]\s+|\(|\)/)) {
    const words = piece.trim().split(/\s+/).filter(Boolean);
    // 1. Runs of capitalised words ("Future of Life Institute", "Neural Transparency").
    let run: string[] = [];
    const flush = () => {
      while (run.length && /^(of|for|and|the|&|de|on)$/i.test(run[run.length - 1])) run.pop();
      const caps = run.filter((w) => /^[A-Z]/.test(w));
      if (caps.length >= 2) terms.add(run.join(' '));
      else if (caps.length === 1 && run[0] !== words[0]) single(run[0]);
      run = [];
    };
    const single = (w: string) => {
      const clean = w.replace(/[^\w.+-]/g, '');
      if (clean.length >= 4 && !COMMON.has(clean.toLowerCase())) terms.add(clean);
    };
    for (const [i, raw] of words.entries()) {
      const w = raw.replace(/^[^\w]+|[^\w+%]+$/g, '');
      if (!w) {
        flush();
        continue;
      }
      if (i === 0 && /^[A-Z][a-z]+$/.test(w)) continue; // "Demonstrated on …": sentence case, not a name
      if (/^[A-Z][\w.+-]*$/.test(w) && !COMMON.has(w.toLowerCase())) run.push(w);
      else if (run.length && /^(of|for|and|the|&|de|on)$/.test(w)) run.push(w);
      else flush();
      // 2. Model/product codes and acronyms: "GPT-6", "Claude-2", "MIB-2026", "AI100", "NASK".
      if (/^[A-Za-z]+[-.]?\d[\w.-]*$|^[A-Za-z]+-[A-Za-z]+[\w-]*$/.test(w) && /[A-Z]/.test(w) && !/^\d/.test(w)) terms.add(w);
      else if (/^[A-Z]{3,6}s?$/.test(w) && !COMMON.has(w.toLowerCase())) terms.add(w);
      // 3. Magnitudes: "30 %", "1 M", "500" (counts ≥ 10 that aren't years).
    }
    flush();
  }
  for (const m of s.matchAll(/\b(\d[\d,.]*)\s?(%|percent|million|billion|M\b|B\b)/g)) terms.add(`${m[1]}${m[2].startsWith('%') || m[2] === 'percent' ? '%' : ` ${m[2]}`}`);
  for (const m of s.matchAll(/(?<![\d.,])\b(\d{2,}(?:,\d{3})*)\b(?![.,]\d)(?!\s?(?:%|percent|million|billion|M\b|B\b))/g)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (n >= 10 && !(n >= 1900 && n <= 2100)) terms.add(m[1]);
  }
  return [...terms].filter((t) => fold(t).length >= 2);
}

/** Is the term in the source? Order-insensitive for multi-word names, number-format tolerant. */
function present(term: string, hay: string, hayWords: Set<string>): boolean {
  const t = fold(term);
  if (!t) return true;
  if (hay.includes(t)) return true;
  if (/^\d/.test(t)) {
    const digits = t.replace(/[^\d.]/g, '');
    const tail = t.endsWith('%') ? '\\s?(?:%|percent)' : '(?![0-9])';
    return digits.length > 0 && new RegExp(`(^|[^0-9.])${digits.replace('.', '\\.')}${tail}`).test(hay.replace(/,/g, ''));
  }
  // Codes with digits ("Claude-2", "GPT-4"): exact, or "Claude 3" in the source would count as "Claude 2".
  if (/\d/.test(t)) return false;
  const words = t.split(' ').filter((w) => w.length >= 3 && !COMMON.has(w));
  return words.length > 0 && words.every((w) => hayWords.has(w) || hay.includes(w));
}

export interface UncitedValue {
  label: string;
  ids: string[];
  values: string[];
}

const MONEY_G = /(?:US\$|\$|€|£|₹)\s?\d[\d,]*(?:\.\d+)?/g;
const THEN_HEADER = /\b(then|before|previous(ly)?|earlier|was|stored|recorded|what (we|i) said)\b/i;
const PAST_MARK = /\b(then|was|were|previously|earlier|before|we said|i said|you were told|from|same as)\b[^.;|]*$/i;

/**
 * Any price in a cited row/sentence must appear in at least one of the sources it cites. This is the
 * format-independent backstop for the structured claim check, which only reads tables and labelled
 * lines. Live regression: "**Supabase flat-fee claim** – Supabase's pricing page lists the Pro plan at
 * $25 per month [S7]", where S7's text holds no $25. Approximations (≈ $16) and arithmetic are skipped.
 */
export function checkCitedValues(answer: string, evidence: Evidence[], recordedValues: string[] = []): UncitedValue[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const out: UncitedValue[] = [];
  for (const seg of segments(answer)) {
    if (!seg.cites.length) continue;
    const srcs = seg.cites.map((id) => byId.get(id)).filter((e): e is Evidence => !!e);
    if (!srcs.length) continue;
    const hay = srcs.map((e) => `${e.title}\n${e.excerpt}`).join('\n');
    const values: string[] = [];
    for (const m of seg.text.matchAll(MONEY_G)) {
      const before = seg.text.slice(Math.max(0, m.index! - 12), m.index);
      const after = seg.text.slice(m.index! + m[0].length, m.index! + m[0].length + 4);
      if (/(≈|~|about|around|roughly|approx\.?|=|×|x)\s*$/i.test(before) || /^\s*[×x*=]/.test(after)) continue;
      if (valueAppearsIn(m[0], hay)) continue;
      // An EARLIER value we recorded ("Then" column, "was $X", "from $X") is checked by the Then guards,
      // not against today's source. A recorded value presented as today's fact still has to be in it.
      const pastCell = seg.table && THEN_HEADER.test(seg.context);
      const pastWords = PAST_MARK.test(seg.text.slice(Math.max(0, m.index! - 40), m.index));
      if ((pastCell || pastWords) && recordedValues.some((r) => valueAppearsIn(m[0], r))) continue;
      values.push(m[0].replace(/\s+/g, ''));
    }
    if (values.length) {
      const label = seg.text.replace(/\[S\d+\]/g, '').replace(/\*\*/g, '').replace(/\s*\|\s*/g, ' – ').replace(/\s+/g, ' ').trim();
      out.push({ label: label.length > 70 ? `${label.slice(0, 67)}…` : label, ids: seg.cites, values: [...new Set(values)] });
    }
  }
  return out;
}

/**
 * @param question  the user's message: terms the user supplied don't need a source.
 */
export function checkGrounding(answer: string, evidence: Evidence[], question = ''): Ungrounded[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const asked = fold(question);
  const out: Ungrounded[] = [];
  for (const seg of segments(answer)) {
    // Price rows are verified value by value (entity, plan, source) by the claim check instead.
    if (/(?:US\$|\$|€|£|₹)\s?\d/.test(seg.text)) continue;
    // An UNCITED factual statement in a turn that searched is held against everything retrieved.
    // Live regression: a forced search returned 10 results and the answer cited none of them.
    if (!seg.cites.length) {
      if (!evidence.length || seg.table === false && seg.text.length < 120) continue;
      if (/^(?:interpretation|note|tip|why|bottom line)\b/i.test(seg.text.replace(/[*_]/g, ''))) continue;
      const words = [...new Set(contentWords(seg.text))];
      const all = new Set(contentWords(fold(evidence.map((e) => `${e.title}\n${e.excerpt}`).join('\n'))));
      const coverage = words.length ? words.filter((w) => all.has(w)).length / words.length : 1;
      if (words.length >= 12 && coverage < 0.3 && !ABSENCE.test(seg.text)) {
        const label = seg.text.replace(/\*\*/g, '').replace(/\s*\|\s*/g, ' – ').replace(/\s+/g, ' ').trim();
        out.push({ label: label.length > 70 ? `${label.slice(0, 67)}…` : label, ids: [], missing: [], coverage: Math.round(coverage * 100) });
      }
      continue;
    }
    const srcs = seg.cites.map((id) => byId.get(id)).filter((e): e is Evidence => !!e);
    if (!srcs.length) continue;
    const hay = fold(srcs.map((e) => `${e.title}\n${e.url}\n${e.domain}\n${e.excerpt}`).join('\n'));
    const hayWords = new Set(hay.split(' '));
    const terms = salientTerms(seg.text).filter((t) => !asked.includes(fold(t)));
    const missing = terms.filter((t) => !present(t, hay, hayWords));
    const namesMissing = terms.length >= 2 && missing.length >= 2 && missing.length / terms.length >= 0.5;
    // Second signal, for statements written in plain lower-case prose (no names to check): how much of
    // the statement's vocabulary is in the source at all. Calibrated on stored answers: rows taken from
    // their source scored 0.33–0.79; the invented interpretability rows scored 0.11–0.35.
    const words = [...new Set(contentWords(seg.text))];
    const hayStems = new Set(contentWords(hay));
    const coverage = words.length ? words.filter((w) => hayStems.has(w)).length / words.length : 1;
    // "No official page lists a price; couldn't verify" reports an absence: its wording is ours by design.
    const absence = ABSENCE.test(seg.text);
    const lowCoverage = words.length >= 12 && coverage < 0.3;
    if (!absence && (namesMissing || lowCoverage)) {
      const label = seg.text.replace(/\(?\[S\d+\]\)?/g, '').replace(/\*\*/g, '').replace(/\s*\|\s*/g, ' – ').replace(/\s+/g, ' ').trim();
      out.push({ label: label.length > 70 ? `${label.slice(0, 67)}…` : label, ids: seg.cites, missing: missing.slice(0, 4), coverage: Math.round(coverage * 100) });
    }
  }
  return out;
}
