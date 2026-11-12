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
  sections: string[]; // query-focused sections (a page hit by two queries can contribute two sections)
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

/**
 * Cut the section(s) of a page whose heading matches the query ("## Gemini 2.5 Flash" for
 * "Gemini 2.5 Flash API pricing"). Search snippets of multi-product pricing pages often lose
 * their heading, which makes the model attribute one product's price to another.
 * A query naming several products ("Gemini 2.5 Flash and Gemini 2.5 Pro") gets one section per
 * product: every heading made up entirely of query words is kept, up to 3.
 */
export function focusedSection(raw: string, query: string, maxChars: number): string | null {
  const q = [...new Set(sectionTokens(query))];
  if (!q.length || !raw) return null;
  const lines = raw.split('\n');
  const cands: { i: number; level: number; score: number; matched: number; precision: number }[] = [];
  lines.forEach((line, i) => {
    const m = /^(#{1,4})\s+(.+)$/.exec(line);
    if (!m) return;
    const h = sectionTokens(m[2]);
    if (!h.length) return;
    const matched = q.filter((t) => h.includes(t)).length;
    const precision = h.filter((t) => q.includes(t)).length / h.length;
    if (!(matched >= Math.min(2, q.length) || (matched >= 1 && precision === 1 && i > 0))) return;
    cands.push({ i, level: m[1].length, score: matched + precision * 0.5, matched, precision });
  });
  if (!cands.length) return null;
  const best = cands.reduce((a, b) => (b.score > a.score ? b : a));
  const picked = [best, ...cands.filter((c) => c !== best && c.precision === 1 && c.matched >= Math.min(2, q.length)).sort((a, b) => b.score - a.score)]
    .slice(0, 3)
    .sort((a, b) => a.i - b.i);
  const per = Math.max(500, Math.floor(maxChars / picked.length));
  const texts = picked
    .map(({ i, level }) => {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const m = /^(#{1,4})\s+/.exec(lines[j]);
        if (m && m[1].length <= level) {
          end = j;
          break;
        }
      }
      return cleanMarkdown(lines.slice(i, end).join('\n'));
    })
    .filter((t) => t.length > 40)
    .map((t) => trimExcerpt(t, per));
  return texts.length ? texts.join('\n') : null;
}

/** Per-turn evidence registry: one ID per canonical URL across all searches in the turn. */
export class EvidenceRegistry {
  private byUrl = new Map<string, Evidence>();
  private list: Evidence[] = [];

  add(
    r: TavilyResult,
    meta: { kind: Evidence['kind']; query: string; retrievedAt: string; excerptChars: number; sectionChars?: number; tierCtx: TierContext },
  ): Evidence {
    const canonicalUrl = canonicalizeUrl(r.url);
    const section = r.raw_content ? focusedSection(r.raw_content, meta.query, meta.sectionChars ?? meta.excerptChars) : null;
    const excerpt = section ?? trimExcerpt(r.content ?? '', meta.excerptChars);
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
      if (section && !existing.sections.includes(section)) {
        existing.sections.push(section);
      } else if (!section && excerpt.length > existing.excerpt.length && existing.sections.length === 1) {
        existing.sections[0] = excerpt;
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
      excerpt,
      sections: [excerpt],
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
