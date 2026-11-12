// Source observations: what a SOURCE states, extracted in code from its excerpt, before any answer
// is written. Two shapes:
//   • price  — entity, plan, attribute, value, unit, period, qualifiers (billing, region)
//   • event  — a release / feature / pricing announcement about an entity
// Each carries its evidence span (verbatim text), the source's publication date, when we fetched
// it, and an explicitly stated effective/event date. These three dates are never conflated.
// The answer is linked to these records afterwards (memory/assertions.ts); the answer's markdown
// is not the data interface.

import * as chrono from 'chrono-node';
import { describeUnit, normalizeText, parseClaims } from '../memory/parseClaims.js';
import { type Evidence, sectionTokens } from '../search/postprocess.js';
import { type Qualifiers, detectQualifiers, mergeQualifiers, valueAppearsIn } from '../verify/diff.js';
import { brandMentioned, entityMentioned, entityNeed, sections, supportedBy } from '../verify/support.js';

export interface Observation {
  id: string; // "S3#2"
  sourceId: string; // "S3"
  kind: 'price' | 'event';
  entity: string;
  plan: string | null;
  attribute: string; // price attribute, or "announcement"
  value: string; // "$9", or the announcement text
  unit: string | null;
  period: string | null;
  qualifiers: Qualifiers;
  span: string; // verbatim text from the source that states it
  publishedAt: string | null; // source publication date
  observedAt: string; // when we fetched the source
  effectiveDate: string | null; // explicitly stated "effective from" date
  eventDate: string | null; // explicitly stated date of the event itself
}

const MONEY = /(?:US\$|\$|€|£|₹)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR)\b/g;
const APPROX = /(≈|~|\babout\b|\baround\b|\broughly\b|\bapprox|\bestimate|\btypical|\bup to\b)/i;
const CREDIT_AFTER = /^\s*(?:\/\s*\w+\s*)?(?:(?:in|of|worth of)\s+)?(?:free\s+|monthly\s+|usage\s+|compute\s+|api\s+)*credits?\b/i;
const CREDIT_BEFORE = /\b(?:credits?|allowance|discount|save|saving|off)\s*(?:of\s*)?$/i;
const ADDON_BEFORE = /\b(?:additional|each additional|extra|add[- ]?ons?|overage|beyond|thereafter|then|after that|per additional)\b[^$€£₹]*$/i;
const ADDON_AFTER = /^\s*(?:\/\s*\w+\s*)?(?:per|for|each)\s+(?:each\s+)?(?:additional|extra)\b/i;

export const LAUNCH_RE =
  /\b(launch(es|ed|ing)?|introduc(es|ed|ing)|announc(es|ed|ing)|unveil(s|ed)?|releas(es|ed)|rolls? out|rolled out|now available|generally available|general availability|ships|shipped|debuts?|acquir(es|ed)|price (increase|hike|change)s?|raises? (its )?prices|new pricing|pricing (update|change)s?|deprecat(es|ed|ing)|sunsets?|discontinu(es|ed))\b/i;

const TUTORIAL_TITLE = /^\s*(?:how to|build(?:ing)?|creat(?:e|ing)|deploy(?:ing)?|set(?:ting)? up|configur(?:e|ing)|using|use|implement(?:ing)?|migrat(?:e|ing)|monitor(?:ing)?|track(?:ing)?|automat(?:e|ing)|get(?:ting)? started|tutorial|step[- ]by[- ]step)\b/i;
const TUTORIAL_TEXT = /\b(?:walkthrough|in this post|we show you|this tutorial|step[- ]by[- ]step|this guide|learn how)\b/i;
// "found no announced retirement of RDS", "has not launched": the opposite of an announcement.
const NEGATED_LAUNCH = /\b(?:no|not|never|without|hasn'?t|haven'?t|didn'?t|isn'?t|wasn'?t|yet to)\b\s+(?:\w+\s+){0,2}(?:announc|launch|releas|introduc|unveil|roll(?:ed|s)? out|ship)/i;
// Parent brands whose name alone does not identify the product ("AWS" ≠ "AWS RDS").
const PARENT_BRANDS = new Set(['aws', 'amazon', 'google', 'microsoft', 'azure', 'meta', 'apple', 'ibm', 'oracle', 'alibaba', 'cloudflare']);
// Words that may follow a brand inside the same product name ("Neon Postgres", "HubSpot Sales Hub").
const PRODUCT_WORDS = new Set(
  `postgres postgresql database db cloud crm api apis ai platform serverless console docs blog pricing plan plans sales hub marketing service studio auth storage compute edge
  functions launch scale pro free team teams enterprise business starter plus premium standard growth professional suite one app apps cli sdk labs research inc`.split(/\s+/),
);

/**
 * Does this sentence talk about `entity` (not a namesake)? The brand must appear, a parent brand
 * needs the product too ("AWS RDS", not any AWS post), and a brand immediately followed by another
 * capitalised name ("Neon Polygons", a game studio) is a different entity.
 * Live regression: Kotaku's "Piece by Piece from Neon Polygons … announced their launch date" was
 * listed as a Neon (the database) announcement.
 */
export function eventMention(entity: string, s: string): boolean {
  if (!brandMentioned(entity, s)) return false;
  const need = entityNeed(entity).filter((t) => !/^\d/.test(t));
  if (need.length >= 2 && PARENT_BRANDS.has(need[0]) && !entityMentioned(entity, s)) return false;
  const brand = need[0];
  const own = new Set(need);
  // In a Title Case headline every word is capitalised ("Neon Launches Branching"): no namesake test.
  const words = s.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && w.length > 3);
  if (words.length >= 3 && words.filter((w) => /^[A-Z]/.test(w)).length / words.length > 0.6) return true;
  const re = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?:['’]s)?(\\s+([A-Z][\\w-]*))?`, 'gi');
  let ok = false;
  for (const m of normalizeText(s).matchAll(re)) {
    const next = m[2];
    if (next && /^[A-Z]/.test(next) && !own.has(next.toLowerCase()) && !PRODUCT_WORDS.has(next.toLowerCase())) continue;
    ok = true;
  }
  return ok;
}

/** Split text into sentences/lines, keeping each under 400 chars. */
export function sentences(text: string): string[] {
  return normalizeText(text)
    .split('\n')
    .flatMap((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').split(/(?<=[.!?])\s+(?=[A-Z0-9*"“(])/))
    .map((s) => s.replace(/^\[[^\]]*\]\s*/, '').trim())
    .filter((s) => s.length >= 8);
}

/** A calendar date stated in `text` (day and month certain), relative to `ref` for a missing year. */
export function explicitDate(text: string, ref: Date): string | null {
  for (const r of chrono.parse(text, { instant: ref, timezone: 'UTC' }, { forwardDate: false })) {
    if (!r.start.isCertain('day') || !r.start.isCertain('month')) continue;
    let y = r.start.get('year')!;
    const m = r.start.get('month')!;
    const d = r.start.get('day')!;
    if (!r.start.isCertain('year')) {
      y = ref.getUTCFullYear();
      if (Date.UTC(y, m - 1, d) > ref.getTime() + 86_400_000) y -= 1;
    }
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

const EFFECTIVE = /\b(?:effective|starting|beginning|takes effect|will apply)\s+(?:on\s+|from\s+|as of\s+)?/gi;

/** A date the text explicitly says something takes effect ("effective March 1, 2027"). */
export function effectiveDateIn(text: string, ref: Date): string | null {
  for (const m of text.matchAll(EFFECTIVE)) {
    const tail = text.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
    const d = explicitDate(tail, ref);
    if (d) return d;
  }
  return null;
}

const PLAN_NEAR = /\b(?:the\s+)?([A-Z][\w+.-]*(?:\s+[A-Z][\w+.-]*){0,2})\s+(?:plan|edition|tier|package)\b/;
const LEAD_LABEL = /^\**([^:$€£₹*]{2,60}?)\**\s*[:–—-]\s/;

/**
 * Can a section heading be a plan name ("Starter", "Sales Hub Professional", "### Launch")? Not an
 * article's sentence-like heading: "Close alternatives at a glance", "What a 5-seat team pays for
 * follow-up automation", "1. Pipedrive: the closest swap" (live regression: those were shown to the
 * user as the "plans" a page listed).
 */
function looksLikePlanHeading(h: string): boolean {
  const t = h.trim();
  if (!t || /pric|plan|cost|overview|compar/i.test(t)) return false;
  if (/^\d+[.)]\s|[:?!]|\b(?:what|how|when|why|which|who|vs|versus|alternatives?|best|top|guide|review|glance|faq|our|your|trial|demo)\b/i.test(t)) return false;
  return t.split(/\s+/).length <= 4;
}

/** Words of `label` that are not the entity's own words: "Sales Hub Starter" for HubSpot → itself. */
function planFrom(label: string, entity: string): string | null {
  const need = new Set(sectionTokens(entity));
  const words = label
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !need.has(w.toLowerCase()) && !/^(plan|tier|edition|package|pricing|price|the)$/i.test(w));
  const out = words.join(' ').trim();
  return out.length >= 2 ? out : null;
}

function attributeFrom(before: string): string {
  const b = before.toLowerCase();
  if (/\binput\b/.test(b)) return 'input_price';
  if (/\boutput\b/.test(b)) return 'output_price';
  if (/\bstorage\b/.test(b)) return 'storage_price';
  if (/\bcompute\b/.test(b)) return 'compute_price';
  return 'price';
}

/**
 * "Zoho" (from a search query) and "Zoho CRM" (from memory) name the same product: keep the most
 * specific name, so the owner of a price isn't lost to a tie between two names for one vendor, and
 * the observation carries the name the stored claim uses. Live regression: "Standard Plan… $14/month"
 * on the earlier answer's own Zoho page was dropped because "Zoho" and "Zoho CRM" both matched.
 */
function oneNamePerVendor<T extends { e: string; i: number }>(xs: T[]): T[] {
  const key = (e: string) => entityNeed(e).join(' ');
  return xs.filter((x) => !xs.some((y) => y !== x && key(y.e) === key(x.e) && (y.e.length > x.e.length || (y.e.length === x.e.length && xs.indexOf(y) < xs.indexOf(x)))));
}

/** The attribute a unit implies on its own: compute per CU-hour, storage per GB-month. */
function unitAttribute(unit: string | null): string | null {
  if (!unit) return null;
  if (/cu[- ]?hour/i.test(unit)) return 'compute_price';
  if (/gb[- ]?month/i.test(unit)) return 'storage_price';
  return null;
}

/** Where in `s` does `entity` start (by its first distinguishing word)? -1 when absent. */
function mentionIndex(entity: string, s: string): number {
  const first = entityNeed(entity)[0];
  if (!first || !entityMentioned(entity, s)) return -1;
  const m = new RegExp(`(^|[^a-z0-9])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').exec(s);
  return m ? m.index : -1;
}

/**
 * Observations stated by one source. Price observations come from the source's own tables and
 * labelled lines (parser) plus prose sentences that name an entity in play; every one must pass the
 * support check (the value sits under that product in the source). Event observations are
 * sentences (or the title) that announce something about an entity in play.
 */
export function extractObservations(ev: Evidence, entities: string[], now: Date): Observation[] {
  const out: Omit<Observation, 'id'>[] = [];
  const base = { sourceId: ev.id, publishedAt: ev.publishedAt, observedAt: ev.retrievedAt };
  const ref = ev.publishedAt ? new Date(`${ev.publishedAt}T12:00:00Z`) : now;
  const lines = normalizeText(ev.excerpt).split('\n');
  const secs = sections(normalizeText(ev.excerpt));
  const spanOf = (value: string, hint?: string) =>
    lines.find((l) => valueAppearsIn(value, l) && (!hint || l.toLowerCase().includes(hint.toLowerCase()))) ?? lines.find((l) => valueAppearsIn(value, l)) ?? '';
  const headingOf = (span: string) => secs.find((s) => s.body.includes(span))?.heading ?? '';
  const known = (entity: string, value: string) => out.some((o) => o.kind === 'price' && o.entity.toLowerCase() === entity.toLowerCase() && o.value.replace(/\s/g, '') === value.replace(/\s/g, ''));

  // 1. Tables and labelled lines, read by the same deterministic parser.
  for (const c of parseClaims(ev.excerpt)) {
    if (c.approximate) continue;
    if (!supportedBy(c.value, c.entity, ev).ok) continue;
    const span = spanOf(c.value, c.plan ?? undefined);
    const context = `${ev.title}\n${headingOf(span)}\n${span}`;
    out.push({ ...base, kind: 'price', entity: c.entity, plan: c.plan, attribute: c.attribute, value: c.value, unit: c.unit, period: c.period, qualifiers: mergeQualifiers(detectQualifiers(span), detectQualifiers(headingOf(span))), span: span.slice(0, 300), effectiveDate: effectiveDateIn(context, ref), eventDate: null });
  }

  // 2. Prose: "Pricing starts at $25 USD per user per month for the Starter edition."
  const inPlay = [...new Set(entities)].filter((e) => entityNeed(e).length);
  for (const s of sentences(ev.excerpt)) {
    const monies = [...s.matchAll(MONEY)];
    if (!monies.length) continue;
    const named = oneNamePerVendor(inPlay.map((e) => ({ e, i: mentionIndex(e, s) })).filter((x) => x.i >= 0));
    let fallback: string | null = null;
    if (!named.length) {
      const ctx = `${ev.title}\n${headingOf(s)}`;
      const inCtx = oneNamePerVendor(inPlay.filter((e) => entityMentioned(e, ctx)).map((e) => ({ e, i: 0 })));
      if (inCtx.length === 1) fallback = inCtx[0].e;
    }
    for (const m of monies) {
      const i = m.index!;
      const before = s.slice(Math.max(0, i - 30), i);
      if (APPROX.test(before)) continue;
      const afterText = s.slice(i + m[0].length, i + m[0].length + 40);
      // "Pro includes $10 in compute credits": an allowance, not a price.
      if (CREDIT_AFTER.test(afterText) || CREDIT_BEFORE.test(before)) continue;
      const owner = named.filter((x) => x.i <= i).sort((a, b) => b.i - a.i)[0]?.e ?? (named.length === 1 ? named[0].e : fallback);
      if (!owner) continue;
      const value = m[0].replace(/\s+/g, '');
      if (known(owner, value)) continue;
      if (!supportedBy(value, owner, ev).ok) continue;
      const after = s.slice(i + m[0].length, i + m[0].length + 48).split(/[;|]|(?=[$€£₹])/)[0];
      const lead = LEAD_LABEL.exec(s);
      // Plan: "Label: $X" lead, "the Starter plan", else the section heading the price sits under.
      const heading = headingOf(s).split(' › ').pop() ?? '';
      const plan =
        (lead && i > lead[0].length - 2 ? planFrom(lead[1], owner) : null) ??
        (PLAN_NEAR.exec(s) ? planFrom(PLAN_NEAR.exec(s)![1], owner) : null) ??
        (heading && looksLikePlanHeading(heading) ? planFrom(heading, owner) : null);
      const { unit, period } = describeUnit(after);
      // "$0.106 per CU-hour compute, $0.35 per GB-month storage": the words after a price name it first.
      const clause = after.split(/,/)[0];
      // "Additional projects from $10/mo", "then $0.125 per GB": an add-on or overage rate, never the
      // plan's own price. Live regression: Supabase's Pro section lost its "$25" in scraping, and
      // "Additional projects from $10/mo" under "### Pro" was compared as the Pro price ($25 → $10).
      const ownClause = before.split(/[.;:,]/).pop() ?? '';
      const byWords = ADDON_BEFORE.test(ownClause) || ADDON_AFTER.test(clause) ? 'addon_price' : attributeFrom(clause) !== 'price' ? attributeFrom(clause) : attributeFrom(before);
      // No word names it, but the unit does: "$0.106 per CU-hr" is a compute price, "$0.35 per GB-month"
      // a storage price. Live regression: Neon's own Launch line was skipped for want of the word "compute".
      // Only on a plain line ("+ $0.35 per GB-month"): "$0.20 per GB-month based on data changes" or
      // "100 snapshots $0.09/GB-month" are other charges in the same unit.
      const rest = s.slice(i + m[0].length).trim();
      const plain = /^[\s+*•·-]*$/.test(s.slice(0, i)) && /^(?:\/\s*|per\s+)[a-z0-9-]+(?:[- ][a-z0-9-]+)?\.?$/i.test(rest);
      const attribute = byWords === 'price' && plain ? (unitAttribute(unit) ?? byWords) : byWords;
      out.push({ ...base, kind: 'price', entity: owner, plan, attribute, value, unit, period, qualifiers: detectQualifiers(s), span: s.slice(0, 300), effectiveDate: effectiveDateIn(s, ref), eventDate: null });
    }
  }

  // 3. Announcements about an entity in play (title first: it is usually the best summary).
  const perEntity = new Map<string, number>();
  const seen = new Set<string>();
  // A tutorial ("Build an … dashboard with …", "How to …") describes steps, not announcements.
  const tutorial = TUTORIAL_TITLE.test(ev.title);
  for (const s of [ev.title, ...sentences(ev.excerpt)]) {
    // "How to launch an agentic contact center" is advice, not an announcement.
    if (!s || s.length < 20 || !LAUNCH_RE.test(s) || /\bhow to\b|\bguide\b|\btips?\b/i.test(s)) continue;
    if (tutorial || TUTORIAL_TEXT.test(s) || NEGATED_LAUNCH.test(s)) continue;
    const text = s.length > 240 ? `${s.slice(0, 237)}…` : s;
    for (const e of inPlay) {
      if (!eventMention(e, s)) continue;
      const brand = entityNeed(e)[0];
      const key = `${brand}|${text}`;
      if (seen.has(key) || (perEntity.get(brand) ?? 0) >= 2) continue;
      seen.add(key);
      perEntity.set(brand, (perEntity.get(brand) ?? 0) + 1);
      out.push({ ...base, kind: 'event', entity: e, plan: null, attribute: 'announcement', value: text, unit: null, period: null, qualifiers: {}, span: text, effectiveDate: effectiveDateIn(s, ref), eventDate: explicitDate(s, ref) });
    }
  }
  return out.map((o, i) => ({ ...o, id: `${ev.id}#${i + 1}` }));
}
