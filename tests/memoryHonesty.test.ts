// Live-review regressions: invented "Then" values, failed turns stored as answers, and the
// re-check pre-fetch covering every item the user named.

import { beforeAll, describe, expect, it, vi } from 'vitest';

// Must run before ANY import loads config.ts (vi.hoisted runs ahead of the imports below);
// otherwise the default data/minimi.db would be written to.
vi.hoisted(() => {
  process.env.DB_PATH = ':memory:';
});

import { route } from '../src/agent/router.js';
import { checkThenValues } from '../src/answer/thenCheck.js';
import { insertEntitySet, insertMessage, upsertConversation } from '../src/memory/db.js';
import { parseNameList } from '../src/memory/parseClaims.js';
import { retrieveMemory } from '../src/memory/retrieve.js';
import type { Evidence } from '../src/search/postprocess.js';
import { domainsForQuery } from '../src/search/tool.js';
import { resolveDates } from '../src/time/resolve.js';
import { buildRecheckPlan } from '../src/verify/reverify.js';

describe('checkThenValues', () => {
  // Q3 in the live run: nothing was stored for 3 Nov, yet the model filled in "Then" and said "No change".
  const invented = `| Vendor | Plan | Then (3 Nov 2026) | Now (11 Nov 2026) | Status |
|---|---|---|---|---|
| Supabase | Pro | $25 / month | $25 / month [S5] | **No change** |
| AWS RDS | t4g.micro | $0.018 / hour | $0.018 / hour [S12] | **No change** |`;

  it('replaces Then values that memory never held, and withdraws the verdict', () => {
    const r = checkThenValues(invented, [], []);
    expect(r.replaced).toBe(2);
    expect(r.text).not.toContain('No change');
    expect(r.text).toContain('not recorded');
    expect(r.text).toContain("Can't compare");
    expect(r.text).toContain('$25 / month [S5]'); // the Now column is untouched
  });

  it('keeps Then values that were actually stored for that item', () => {
    const r = checkThenValues(invented, [{ entity: 'Supabase', value: '$25 per month' }, { entity: 'AWS RDS', value: '$0.018 per hour' }], []);
    expect(r.replaced).toBe(0);
    expect(r.text).toBe(invented);
  });

  it('a stored number for a DIFFERENT item does not make a Then value recorded', () => {
    const r = checkThenValues(invented, [{ entity: 'Pipedrive', value: '$25 per seat per month' }], []);
    expect(r.replaced).toBe(2);
  });

  it("today's source never establishes a past value: an undated page fetched now is not history", () => {
    const today = { id: 'S5', title: 'Supabase pricing', excerpt: 'Pro: $25 per month', publishedAt: null } as Evidence;
    const cited = '| Item | Then | Now | Status |\n|---|---|---|---|\n| Supabase Pro | $25 [S5] | $25 [S5] | Unchanged |';
    const r = checkThenValues(cited, [], [today], '2026-11-03');
    expect(r.replaced).toBe(1);
    expect(r.text).not.toContain('Unchanged');
  });

  it('a source published on or before the anchor may support a historical market fact', () => {
    const old = { id: 'S3', title: 'Supabase pricing update', excerpt: 'Pro was $25 per month.', publishedAt: '2026-10-01' } as Evidence;
    const cited = '| Item | Then | Now | Status |\n|---|---|---|---|\n| Supabase Pro | $25 [S3] | $35 [S4] | Changed |';
    expect(checkThenValues(cited, [], [old], '2026-11-03').replaced).toBe(0);
  });

  it('ignores ordinary tables', () => {
    const t = '| Model | Input | Output |\n|---|---|---|\n| Gemini 2.5 Flash | $0.30 [S1] | $2.50 [S1] |';
    expect(checkThenValues(t, [], []).replaced).toBe(0);
  });
});

describe('parseNameList', () => {
  it('reads the items the user named', () => {
    expect(parseNameList('What do Neon, Supabase and AWS RDS charge for their entry-level paid plans?')).toEqual(['Neon', 'Supabase', 'AWS RDS']);
    expect(parseNameList('Compare HubSpot, Salesforce, Zoho CRM, Pipedrive and Freshsales for us')).toEqual(['HubSpot', 'Salesforce', 'Zoho CRM', 'Pipedrive', 'Freshsales']);
    expect(parseNameList('Is Neon or Supabase cheaper?')).toEqual(['Neon', 'Supabase']);
  });
  it('needs at least two names', () => {
    expect(parseNameList('Shortlist 5 CRM tools for us')).toEqual([]);
    expect(parseNameList('What is the price of Gemini 2.5 Pro?')).toEqual([]);
  });
});

describe('domainsForQuery with one domain and several queries', () => {
  const qs = ['Neon Launch pricing', 'Supabase Pro pricing', 'AWS RDS PostgreSQL pricing'];
  it("doesn't restrict other vendors' queries to the one named domain (live neon.tech regression)", () => {
    expect(domainsForQuery('Neon Launch pricing', ['neon.tech'], qs)).toEqual(['neon.tech']);
    expect(domainsForQuery('Supabase Pro pricing', ['neon.tech'], qs)).toEqual([]);
  });
  it('a domain no query names still applies to all of them (ai.google.dev for Gemini)', () => {
    const g = ['Gemini 2.5 Flash pricing', 'Gemini 2.5 Pro pricing'];
    expect(domainsForQuery(g[1], ['ai.google.dev'], g)).toEqual(['ai.google.dev']);
  });
});

describe('buildRecheckPlan', () => {
  it('covers listed items that have no stored value', () => {
    const plan = buildRecheckPlan([], '2026-11-03', ['Neon', 'Supabase', 'AWS RDS']);
    expect(plan).toEqual({ since: '2026-11-03', queries: ['Neon pricing', 'Supabase pricing', 'AWS RDS pricing'], domains: [] });
  });
  it('nothing to re-check without claims or items', () => {
    expect(buildRecheckPlan([], '2026-11-03', [])).toBeNull();
  });
});

describe('retrieveMemory: a failed turn is remembered as a question, never as an answer', () => {
  beforeAll(() => {
    const at = '2026-11-03T08:50:00.000Z';
    upsertConversation('seed-postgres', 'Postgres hosting', at, 'UTC');
    insertMessage({ conversation_id: 'seed-postgres', role: 'user', content: 'What do Neon, Supabase and AWS RDS charge for managed Postgres hosting?', created_at: at, local_date: '2026-11-03', user_tz: 'UTC', meta_json: null });
    const a = insertMessage({ conversation_id: 'seed-postgres', role: 'assistant', content: "Sorry, I couldn't produce an answer this time.", created_at: at, local_date: '2026-11-03', user_tz: 'UTC', meta_json: null, failed: true });
    insertEntitySet(a, 'postgres question', ['Neon', 'Supabase', 'AWS RDS']);
  });

  it('memory says no answer was given, and the re-check still covers every named item', () => {
    const msg = 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?';
    const windows = resolveDates(msg, new Date('2026-11-11T10:00:00Z'), 'UTC');
    const r = retrieveMemory({ message: msg, windows, route: route(msg, true), conversationId: 'current', tz: 'UTC' });
    expect(r.turns).toHaveLength(1);
    expect(r.block).toContain('No answer was given at the time');
    expect(r.block).not.toContain("Sorry, I couldn't");
    expect(r.block).toContain('No values were stored');
    expect(r.recheck?.queries).toEqual(['Neon pricing', 'Supabase pricing', 'AWS RDS pricing']);
    expect(r.recheck?.since).toBe('2026-11-03');
  });
});

describe('fitToBudget (live 413 regression: a third search round pushed a request to 8,017 tokens)', () => {
  const big = (id: string) => ({ role: 'tool' as const, tool_call_id: id, content: `[S1] ${'row | $9 | seat\n'.repeat(900)}` });
  const convo = () =>
    [
      { role: 'system' as const, content: 'system prompt '.repeat(100) },
      { role: 'user' as const, content: 'has it changed?' },
      big('a'),
      big('b'),
      big('c'),
    ] as import('openai/resources/chat/completions').ChatCompletionMessageParam[];

  it('shrinks old search results until the request fits, newest kept longest', async () => {
    const { fitToBudget, estimateTokens } = await import('../src/agent/loop.js');
    const msgs = convo();
    expect(estimateTokens(msgs)).toBeGreaterThan(5800);
    const fit = fitToBudget(msgs, 5800);
    expect(estimateTokens(fit)).toBeLessThanOrEqual(5800);
    const tools = fit.filter((m) => m.role === 'tool').map((m) => String(m.content).length);
    expect(tools[2]).toBeGreaterThanOrEqual(tools[0]); // newest result is not shorter than the oldest
    expect(String(fit.find((m) => m.role === 'tool')!.content)).toContain('[S1]'); // evidence ids survive
    expect(msgs.map((m) => String(m.content).length)).toEqual(convo().map((m) => String(m.content).length)); // input not mutated
  });

  it('leaves a request that already fits untouched', async () => {
    const { fitToBudget } = await import('../src/agent/loop.js');
    const small = [{ role: 'user' as const, content: 'hi' }];
    expect(fitToBudget(small, 5800)).toBe(small);
  });
});
