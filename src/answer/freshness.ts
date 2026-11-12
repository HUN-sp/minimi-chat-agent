// Freshness of the sources behind a CURRENT price. A price page published more than six months ago
// may quote a superseded price; the tool output marks such sources OLD, but the model can still cite
// one for "current pricing". Code checks it: a price whose every cited source is old is flagged.
// Live regression: "HubSpot Starter $7 / user (Nov 2026 pricing)" cited a hubspot.com page from 2018.

import type { Evidence } from '../search/postprocess.js';

export const STALE_DAYS = 183;

export function staleCutoff(today: string): string {
  return new Date(Date.parse(today) - STALE_DAYS * 86_400_000).toISOString().slice(0, 10);
}

export const isStale = (e: Evidence | undefined, today: string): boolean => !!e?.publishedAt && e.publishedAt < staleCutoff(today);

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
