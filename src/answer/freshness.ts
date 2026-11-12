// Freshness of the sources behind a CURRENT price. One rule, used everywhere (labels, the "possibly
// outdated" note, the OLD marker in search results, and the re-check's "Now" value):
//
//   • A LIVE page (a vendor's pricing / plans / docs / product page) shows today's price, whatever its
//     date: the date a search engine gives it is when the page was last edited, not when the price
//     was set. A price unchanged since April is still today's price. Only a page not updated for over
//     a year is treated as possibly outdated: search engines can hold a stale copy (live regression:
//     "HubSpot Starter $7 / user (Nov 2026 pricing)" cited a hubspot.com pricing page dated 2018).
//   • An ARTICLE (blog post, news story, press release, changelog entry) describes the moment it was
//     written. One published before the date we are checking from can't say what the price is now
//     (live regression: Neon's Aug 2025 pricing blog shown as the "Now" value of a Nov 2026 re-check),
//     and one older than six months is marked OLD.

import type { Evidence } from '../search/postprocess.js';

export const STALE_DAYS = 183; // articles
export const LIVE_PAGE_DAYS = 365; // live vendor pages

const DAY = 86_400_000;
const cutoff = (today: string, days: number) => new Date(Date.parse(today) - days * DAY).toISOString().slice(0, 10);

export function staleCutoff(today: string): string {
  return cutoff(today, STALE_DAYS);
}

const LIVE_HOST = /^(?:docs|support|help|developers?|kb|knowledge|learn)\./i;
const ARTICLE_HOST = /^(?:blogs?|news|newsroom|press|community|forums?|medium)\./i;
const ARTICLE_PATH =
  /(?:^|[/=])(?:blogs?|news|newsroom|press|press-releases?|stories|articles|posts?|insights|announcements?|changelog|release-notes|whats-new|webinars?|events?|podcasts?)(?:\/|$)|\/20\d{2}\/\d{1,2}(?:\/|$)/i;

/** Is this source a live page that shows the current state, or an article written at a point in time? */
export function pageKind(e: Pick<Evidence, 'url'> & { kind?: Evidence['kind'] }): 'live' | 'article' {
  if (e.kind === 'news' || e.kind === 'updates') return 'article';
  let host = '';
  let path = '';
  try {
    const u = new URL(e.url);
    host = u.hostname.replace(/^www\./, '');
    path = decodeURIComponent(u.pathname + u.search).toLowerCase();
  } catch {
    return 'article';
  }
  if (LIVE_HOST.test(host)) return 'live';
  if (ARTICLE_HOST.test(host) || ARTICLE_PATH.test(path)) return 'article';
  return 'live';
}

/** Marked OLD: an article over six months old, or a live page not updated for over a year. */
export const isStale = (e: Evidence | undefined, today: string): boolean =>
  !!e?.publishedAt && e.publishedAt < cutoff(today, pageKind(e) === 'article' ? STALE_DAYS : LIVE_PAGE_DAYS);

/**
 * Can this source give TODAY's value in a re-check anchored at `anchor`? Undated pages: yes (current
 * as fetched). Live pages: yes unless not updated for over a year. Articles: only if published on or
 * after the anchor.
 */
export function tooOldForNow(e: Evidence, anchor: string, today: string): boolean {
  if (!e.publishedAt) return false;
  return pageKind(e) === 'article' ? e.publishedAt < anchor : e.publishedAt < cutoff(today, LIVE_PAGE_DAYS);
}

export interface StalePrice {
  entity: string;
  plan: string | null;
  value: string;
  sources: { id: string; publishedAt: string }[];
}

/** Prices whose cited sources are ALL older than six months (undated pages count as current). */
export function stalePrices(claims: { entity: string; plan: string | null; value: string; sources: string[]; approximate: boolean }[], evidence: Evidence[], today: string): StalePrice[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const out: StalePrice[] = [];
  for (const c of claims) {
    if (c.approximate || !c.sources.length) continue;
    const cited = c.sources.map((id) => byId.get(id)).filter((e): e is Evidence => !!e);
    if (!cited.length || !cited.every((e) => isStale(e, today))) continue;
    out.push({ entity: c.entity, plan: c.plan, value: c.value, sources: cited.map((e) => ({ id: e.id, publishedAt: e.publishedAt! })) });
  }
  return out;
}
