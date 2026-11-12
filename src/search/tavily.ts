// Thin Tavily REST wrapper. Plain fetch keeps full control over the date parameters.
// Every call sets search_depth "basic" explicitly (1 credit).

import { config } from '../config.js';

export interface TavilyParams {
  query: string;
  topic?: 'general' | 'news';
  max_results?: number;
  include_domains?: string[];
  start_date?: string; // YYYY-MM-DD
  max_age_hours?: number; // not used: 0 ("live fetch") returned different pages without raw content in testing
  raw?: boolean; // include the page as markdown (same credit cost) for heading-aware excerpts
}

export interface TavilyResult {
  url: string;
  title: string;
  content: string;
  score: number;
  published_date?: string | null;
  raw_content?: string | null;
}

export interface TavilyResponse {
  results: TavilyResult[];
  response_time?: number;
  credits: number;
}

export async function tavilySearch(p: TavilyParams, signal?: AbortSignal): Promise<TavilyResponse> {
  if (!config.tavilyKey) throw new Error('TAVILY_API_KEY is not set');
  const body: Record<string, unknown> = {
    query: p.query,
    search_depth: 'basic',
    topic: p.topic ?? 'general',
    max_results: p.max_results ?? config.budgets.resultsPerQuery,
    include_published_date: true,
    include_answer: false,
  };
  if (p.include_domains?.length) body.include_domains = p.include_domains;
  if (p.start_date) body.start_date = p.start_date;
  if (p.max_age_hours !== undefined) body.max_age_hours = p.max_age_hours;
  if (p.raw) body.include_raw_content = 'markdown';

  const timeout = AbortSignal.timeout(12_000);
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.tavilyKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tavily ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { results?: TavilyResult[]; response_time?: number };
  return { results: json.results ?? [], response_time: json.response_time, credits: 1 };
}
