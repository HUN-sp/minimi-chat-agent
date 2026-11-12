// In-memory TTL cache for search calls: saves free credits on follow-ups and retries.
// A hit returns the ORIGINAL fetch time: a cached page was observed then, not now.

import { config } from '../config.js';

const store = new Map<string, { at: number; fetchedAt: number; value: unknown }>();

function stableKey(params: unknown): string {
  return JSON.stringify(params, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

export async function cached<T>(params: unknown, fn: () => Promise<T>, now: () => number = Date.now): Promise<{ value: T; hit: boolean; fetchedAt: number }> {
  const key = stableKey(params);
  const entry = store.get(key);
  if (entry && Date.now() - entry.at < config.cacheTtlMs) return { value: entry.value as T, hit: true, fetchedAt: entry.fetchedAt };
  const value = await fn();
  const fetchedAt = now();
  store.set(key, { at: Date.now(), fetchedAt, value });
  if (store.size > 150) store.delete(store.keys().next().value!);
  return { value, hit: false, fetchedAt };
}

export function clearCache(): void {
  store.clear();
}
