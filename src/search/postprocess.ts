// Post-processing in code: canonicalise URLs, dedupe, trim, date-stamp, tier, and assign
// stable evidence IDs (S1, S2…) that the model cites and the validator checks.

import { createHash } from 'node:crypto';
import type { Observation } from '../evidence/observations.js';
import { type Tier, type TierContext, decideTier, hostOf } from './credibility.js';
import type { TavilyResult } from './tavily.js';

const TRACKING_PARAMS = /^(utm_.*|hl|authuser|gclid|fbclid|msclkid|ref|ref_src|_gl|si|source|mc_cid|mc_eid|igshid|lang)$/i;

export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
    const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
    u.search = keep.length ? '?' + new URLSearchParams(keep).toString() : '';
    let s = u.toString();
    if (u.pathname.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    else if (u.pathname === '/' && !u.search) s = s.replace(/\/$/, '');
    return s.replace(/^http:\/\//, 'https://');
  } catch {
    return raw.trim();
  }
}

/** Trim to `max` chars on a word boundary, collapsing whitespace and markdown noise. */
export function trimExcerpt(text: string, max: number): string {
  const clean = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.8 ? cut.slice(0, sp) : cut) + '…';
}

/** Tavily dates look like "Thu, 14 Aug 2025 13:03:58 GMT". Returns YYYY-MM-DD or null. */
export function normalizeDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const t = Date.parse(d);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

export function dedupe<T extends { url: string; score?: number }>(results: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of results) {
    const key = canonicalizeUrl(r.url);
    const prev = best.get(key);
    if (!prev || (r.score ?? 0) > (prev.score ?? 0)) best.set(key, r);
  }
  return [...best.values()];
}

export interface Evidence {
  id: string; // S1…
  url: string;
  canonicalUrl: string;
  domain: string;
  title: string;
  excerpt: string; // all sections joined
  /** Self-contained chunks (each restates its heading path and table header); a page hit by two queries can contribute chunks for both. */
  sections: string[];
  /** The chunks come from the page itself (not just the search engine's snippet). */
  fromPage?: boolean;
  /** A page the earlier answer cited, opened again in this turn (re-check of the same source). */
  reread?: boolean;
  publishedAt: string | null; // when the source says it was published (YYYY-MM-DD), not when we read it
  retrievedAt: string; // ISO: when the page was actually fetched (the ORIGINAL fetch on a cache hit)
  effectiveDate?: string | null; // a date the source explicitly states a change takes effect
  tier: Tier;
  tierReason?: string; // why this tier (e.g. "the domain hubspot.com is the HubSpot brand name")
  publisherFor?: string[]; // entities this source is the official publisher for
  kind: 'primary' | 'news' | 'general' | 'updates';
  query: string;
  contentHash: string;
  /** What this source states, extracted in code from its excerpt (filled by the search tool). */
  observations?: Observation[];
}

const SECTION_STOP = new Set([
  'api', 'pricing', 'price', 'prices', 'cost', 'costs', 'plan', 'plans', 'per', 'the', 'and', 'for', 'how', 'much', 'what', 'is',
  'current', 'latest', 'official', 'page', 'news', 'change', 'changes', 'update', 'updates', 'tokens', 'token', 'month', 'monthly',
  'vs', 'of', 'a', 'in', 'on', 'to', 'or', 'with', 'input', 'output', '1m', 'million', '2024', '2025', '2026', '2027',
]);

export function sectionTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !SECTION_STOP.has(t));
}

function cleanMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/(\[[^\]]*\]\([^)]*\)\s*){3,}/g, '') // link bars ("[Standard](…)[Batch](…)[Flex](…)")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\|\s*-{3,}\s*(\|\s*-{3,}\s*)*\|/g, '|---|')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Heading- and table-aware excerpts.
//
// A price is only checkable if the product it belongs to travels with it. Pricing pages put the
// product in a heading ("## Gemini 2.5 Flash") and the meaning of each column in the table's header
// row ("| | Free Tier | Paid Tier |"). Search snippets routinely cut both off. Live regression: an
// ai.google.dev snippet "| Input price | Free of charge | $2.00 |" with no model name was answered as
// "Gemini 2.5 Flash: $2.00, Confirmed".
//
// So excerpts are built from the page itself, as self-contained CHUNKS: every chunk starts with the
// heading path it sits under, and a table split across chunks repeats its header row in each one.
// A section is never cut mid-table; a long one is divided into more chunks instead. The code checks
// read every chunk; the model is shown as many whole chunks as its token budget allows.
// ---------------------------------------------------------------------------------------------

/** Hard ceiling per page, as whole chunks: one runaway page must not swamp the turn or the database. */
export const PAGE_MAX_CHARS = 40_000;

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}/;

/**
 * Clean a page's markdown and normalise headings nested in list items ("* ### Free" → "### Free").
 * Bold markers are removed from headings only: in body text "**Standard Plan**Priced at $14" must not
 * become "Standard PlanPriced", which hides the plan name from the parser.
 */
function prepareLines(raw: string): string[] {
  const md = raw.replace(/^[ \t]*(?:[*+-][ \t]+)?(#{1,6})[ \t]+(.*)$/gm, (_m, h: string, t: string) => `${h} ${t.replace(/\*\*/g, '').trim()}`);
  return cleanMarkdown(md)
    .split('\n')
    .map((l) => l.trimEnd());
}

type Head = { level: number; text: string };
const headLine = (h: Head) => `${'#'.repeat(Math.min(h.level, 4))} ${h.text}`;

/** Ancestor headings in force at line `i` (outermost first). */
function pathAt(lines: string[], i: number): Head[] {
  const stack: Head[] = [];
  for (let j = 0; j <= i && j < lines.length; j++) {
    const m = HEADING.exec(lines[j]);
    if (!m) continue;
    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text: m[2] });
  }
  return stack;
}

/** End (exclusive) of the section opened by the heading at line `i`. */
function sectionEnd(lines: string[], i: number): number {
  const level = HEADING.exec(lines[i])?.[1].length ?? 0;
  for (let j = i + 1; j < lines.length; j++) {
    const m = HEADING.exec(lines[j]);
    if (m && m[1].length <= level) return j;
  }
  return lines.length;
}

/**
 * Split lines [start, end) into self-contained chunks of about `maxChunk` chars. `ancestors` is the
 * heading path above `start` (the heading AT start, if any, is part of the lines).
 */
export function chunkLines(lines: string[], start: number, end: number, ancestors: Head[], maxChunk: number): string[] {
  const chunks: string[] = [];
  const stack = [...ancestors];
  let table: string[] | null = null; // header row + separator of the table we are in
  let cur: string[] = [];
  let curLen = 0;
  let hasBody = false;

  const open = (withTable: boolean) => {
    cur = stack.map(headLine);
    if (withTable && table) cur.push(...table);
    curLen = cur.reduce((a, l) => a + l.length + 1, 0);
    hasBody = false;
  };
  const flush = () => {
    if (hasBody) chunks.push(cur.join('\n'));
  };
  open(false);

  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: h[2] });
      table = null;
      if (!hasBody) {
        open(false); // nothing under the previous heading yet: just restate the path
      } else if (curLen > maxChunk / 2) {
        flush(); // a well-filled chunk: start the next one under the new heading
        open(false);
      } else {
        // Small sub-sections stay together; the heading line keeps them apart inside the chunk.
        const hl = headLine(stack[stack.length - 1]);
        cur.push(hl);
        curLen += hl.length + 1;
      }
      continue;
    }
    const isRow = TABLE_ROW.test(line);
    if (isRow && i + 1 < end && TABLE_SEP.test(lines[i + 1]) && !TABLE_SEP.test(line)) {
      // A table header row: it (and its separator) is repeated at the top of every chunk of this table.
      const header = [line, '|---|'];
      if (hasBody && curLen + line.length > maxChunk) {
        flush();
        open(false);
      }
      table = header;
      cur.push(...header);
      curLen += line.length + 6;
      i++; // skip the separator
      continue;
    }
    if (isRow && TABLE_SEP.test(line)) continue;
    if (!isRow) table = null;
    if (hasBody && curLen + line.length + 1 > maxChunk) {
      flush();
      open(isRow);
    }
    cur.push(line);
    curLen += line.length + 1;
    hasBody = true;
  }
  flush();
  return chunks;
}

/** Keep whole chunks, in order, up to the page ceiling. */
function capChunks(chunks: string[]): string[] {
  const out: string[] = [];
  let total = 0;
  for (const c of chunks) {
    if (out.length && total + c.length > PAGE_MAX_CHARS) break;
    out.push(c);
    total += c.length;
  }
  return out;
}

/**
 * The section(s) of a page whose heading path matches the query ("## Gemini 2.5 Flash" for
 * "Gemini 2.5 Flash API pricing"; "### Launch" under "# Neon pricing" for "Neon Launch pricing"),
 * as self-contained chunks. A query naming several products gets up to 3 sections.
 */
export function focusedChunks(raw: string, query: string, maxChunk: number): string[] | null {
  const q = [...new Set(sectionTokens(query))];
  if (!q.length || !raw) return null;
  const lines = prepareLines(raw);
  const cands: { i: number; level: number; score: number; matched: number; precision: number }[] = [];
  const stack: Head[] = [];
  lines.forEach((line, i) => {
    const m = HEADING.exec(line);
    if (!m) return;
    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text: m[2] });
    const own = sectionTokens(m[2]);
    if (!own.length) return;
    // Matched against the whole heading PATH: the product name often lives in an ancestor heading.
    const path = new Set(stack.flatMap((h) => sectionTokens(h.text)));
    const matched = q.filter((t) => path.has(t)).length;
    const precision = own.filter((t) => q.includes(t)).length / own.length;
    if (!(matched >= Math.min(2, q.length) || (matched >= 1 && precision === 1 && i > 0))) return;
    cands.push({ i, level, score: matched + precision * 0.5, matched, precision });
  });
  if (!cands.length) return null;
  // Best: most query words matched; ties go to the more specific (deeper) heading.
  const best = cands.reduce((a, b) => (b.score > a.score || (b.score === a.score && b.level > a.level) ? b : a));
  const bestEnd = sectionEnd(lines, best.i);
  const others = cands
    .filter((c) => c !== best && c.precision === 1 && c.matched >= Math.min(2, q.length) && !(c.i > best.i && c.i < bestEnd))
    .sort((a, b) => b.score - a.score);
  const picked = [best, ...others].slice(0, 3).sort((a, b) => a.i - b.i);
  const chunks = picked.flatMap(({ i }) => chunkLines(lines, i, sectionEnd(lines, i), pathAt(lines, i).slice(0, -1), maxChunk));
  // chunkLines only emits chunks with content (and a price may sit in a heading: "#### $0.106 / CU-hour").
  return chunks.length ? capChunks(chunks) : null;
}

/** Back-compat: the focused section(s) as one string. */
export function focusedSection(raw: string, query: string, maxChars: number): string | null {
  const chunks = focusedChunks(raw, query, maxChars);
  return chunks ? chunks.join('\n') : null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$.]/g, '');

/**
 * Where on the page did the search engine's snippet come from? Each "[...]"-separated piece of the
 * snippet is located in the page (ignoring markup and spacing), and the smallest section around it
 * is returned as chunks, with its heading path and table headers restored. The chunk holding the
 * snippet comes first.
 */
export function snippetChunks(raw: string, snippet: string, maxChunk: number): string[] | null {
  if (!raw || !snippet) return null;
  const lines = prepareLines(raw);
  // Normalised page text, with a map from normalised offset → line index.
  let flat = '';
  const lineAt: number[] = [];
  lines.forEach((l, i) => {
    const n = norm(l);
    flat += n;
    for (let k = 0; k < n.length; k++) lineAt.push(i);
  });
  // Locate a snippet piece by a 24-char probe that occurs exactly ONCE on the page: pricing tables
  // repeat row labels ("Output price | Free of charge") under every product, and only a probe that
  // reaches the distinctive part ("$12.00 or $0.002/min") says which table the snippet came from.
  const locate = (n: string): number => {
    const whole = flat.indexOf(n);
    if (whole >= 0 && flat.indexOf(n, whole + 1) < 0) return whole; // the whole piece, verbatim and unique
    let fallback = -1;
    for (let at = 0; at + 24 <= n.length; at += 6) {
      const probe = n.slice(at, at + 24);
      const k = flat.indexOf(probe);
      if (k < 0) continue;
      if (flat.indexOf(probe, k + 1) < 0) return k;
      if (fallback < 0) fallback = k;
    }
    return fallback;
  };
  const hits = new Set<number>();
  for (const piece of snippet.split(/\s*\[\.\.\.\]\s*|…/)) {
    const n = norm(piece);
    if (n.length < 24) continue;
    const k = locate(n);
    if (k >= 0) hits.add(lineAt[k]);
  }
  if (!hits.size) return null;
  const out: string[] = [];
  const seen = new Set<number>();
  // In the snippet's own order: the search engine put the most relevant piece first.
  for (const hit of hits) {
    // The nearest heading above the hit opens the smallest section that contains it.
    let h = -1;
    for (let j = hit; j >= 0; j--) if (HEADING.test(lines[j])) { h = j; break; }
    if (seen.has(h)) continue;
    seen.add(h);
    let start: number;
    let end: number;
    let ancestors: Head[];
    if (h >= 0) {
      start = h;
      end = sectionEnd(lines, h);
      ancestors = pathAt(lines, h).slice(0, -1);
    } else if (TABLE_ROW.test(lines[hit])) {
      // No heading above, inside a table: the WHOLE table, plus the lines just before it (its caption).
      start = hit;
      while (start > 0 && TABLE_ROW.test(lines[start - 1])) start--;
      start = Math.max(0, start - 3);
      end = hit + 1;
      while (end < lines.length && TABLE_ROW.test(lines[end])) end++;
      ancestors = [];
    } else {
      // No heading above, in text: the surrounding passage.
      start = Math.max(0, hit - 15);
      end = Math.min(lines.length, hit + 15);
      ancestors = [];
    }
    const chunks = chunkLines(lines, start, end, ancestors, maxChunk);
    // Put the chunk containing the snippet first: it is what the search judged relevant.
    const probeLine = norm(lines[hit]).slice(0, 40);
    const first = chunks.findIndex((c) => norm(c).includes(probeLine));
    if (first > 0) chunks.unshift(...chunks.splice(first, 1));
    out.push(...chunks);
    if (seen.size >= 3) break;
  }
  return out.length ? capChunks(out) : null;
}

/** The whole page as chunks (within the page ceiling). */
export function wholePageChunks(raw: string, maxChunk: number): string[] | null {
  const lines = prepareLines(raw);
  const chunks = chunkLines(lines, 0, lines.length, [], maxChunk);
  return chunks.length ? capChunks(chunks) : null;
}

/** A snippet holding table rows but no heading: say so, so nobody attributes its prices to a product. */
function markHeadless(snippet: string): string {
  return /^\s*\|.*\|\s*$/m.test(snippet) && !/^#{1,6}\s/m.test(snippet)
    ? `(Part of a table whose heading was not returned: the product these rows belong to is unknown.)\n${snippet}`
    : snippet;
}

/** Per-turn evidence registry: one ID per canonical URL across all searches in the turn. */
export class EvidenceRegistry {
  private byUrl = new Map<string, Evidence>();
  private list: Evidence[] = [];

  add(
    r: TavilyResult,
    meta: { kind: Evidence['kind']; query: string; retrievedAt: string; excerptChars: number; sectionChars?: number; chunkChars?: number; tierCtx: TierContext; reread?: boolean },
  ): Evidence {
    const canonicalUrl = canonicalizeUrl(r.url);
    const chunkSize = meta.chunkChars ?? meta.sectionChars ?? meta.excerptChars;
    // From the page itself when we have it: the section matching the query, else the section the
    // search snippet came from. Only without the page do we fall back to the bare snippet.
    // A page re-opened for a re-check has no snippet: if no heading matches, keep the whole page (in chunks).
    const chunks = r.raw_content
      ? (focusedChunks(r.raw_content, meta.query, chunkSize) ?? snippetChunks(r.raw_content, r.content ?? '', chunkSize) ?? (meta.reread ? wholePageChunks(r.raw_content, chunkSize) : null))
      : null;
    const fallback = markHeadless(trimExcerpt(r.content ?? '', meta.excerptChars));
    const sections = chunks ?? [fallback];
    const existing = this.byUrl.get(canonicalUrl);
    if (existing) {
      // Keep the oldest fetch time: part of what we hold was observed then.
      if (meta.retrievedAt < existing.retrievedAt) existing.retrievedAt = meta.retrievedAt;
      const d = decideTier(r.url, meta.tierCtx, r.title ?? '');
      for (const e of d.publisherFor) if (!existing.publisherFor?.includes(e)) (existing.publisherFor ??= []).push(e);
      if (d.tier === 'official' && existing.tier !== 'official') {
        existing.tier = 'official';
        existing.tierReason = d.reason;
      }
      if (meta.reread) existing.reread = true;
      if (chunks) {
        // A bare snippet is replaced by real page chunks; new chunks are appended (within the page ceiling).
        if (!existing.fromPage) existing.sections = [];
        existing.fromPage = true;
        for (const c of chunks) if (!existing.sections.includes(c)) existing.sections.push(c);
        existing.sections = capChunks(existing.sections);
      } else if (!existing.fromPage && fallback.length > existing.excerpt.length && existing.sections.length === 1) {
        existing.sections[0] = fallback;
      }
      existing.excerpt = existing.sections.join('\n…\n');
      return existing;
    }
    const d = decideTier(r.url, meta.tierCtx, r.title ?? '');
    const ev: Evidence = {
      id: `S${this.list.length + 1}`,
      url: r.url,
      canonicalUrl,
      domain: hostOf(r.url),
      title: (r.title ?? '').trim().slice(0, 200),
      excerpt: sections.join('\n…\n'),
      sections,
      fromPage: !!chunks,
      reread: meta.reread || undefined,
      publishedAt: normalizeDate(r.published_date),
      retrievedAt: meta.retrievedAt,
      tier: d.tier,
      tierReason: d.reason,
      publisherFor: d.publisherFor,
      kind: meta.kind,
      query: meta.query,
      contentHash: createHash('sha256').update(r.raw_content ?? r.content ?? '').digest('hex').slice(0, 16),
    };
    this.byUrl.set(canonicalUrl, ev);
    this.list.push(ev);
    return ev;
  }

  get(id: string): Evidence | undefined {
    return this.list.find((e) => e.id === id);
  }

  ids(): Set<string> {
    return new Set(this.list.map((e) => e.id));
  }

  all(): Evidence[] {
    return [...this.list];
  }
}

const TIER_ORDER: Record<Tier, number> = { official: 0, reputable: 1, secondary: 2 };

/** Official first, then by relevance order. */
export function rankByTier<T extends { tier: Tier }>(items: T[]): T[] {
  return items.map((it, i) => ({ it, i })).sort((a, b) => TIER_ORDER[a.it.tier] - TIER_ORDER[b.it.tier] || a.i - b.i).map((x) => x.it);
}
