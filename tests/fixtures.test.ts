// The memory fixtures (scripts/fixtures.ts) as a regression suite: known past conversations are
// written into an in-memory DB and we check what retrieval hands the model for each sample question.
// No LLM and no network: this tests the memory path deterministically.

import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DB_PATH = ':memory:';
});

import { loadFixtures } from '../scripts/fixtures.js';
import { route } from '../src/agent/router.js';
import { retrieveMemory } from '../src/memory/retrieve.js';
import { resolveDates } from '../src/time/resolve.js';
import { civilDateIn } from '../src/time/tz.js';

const NOW = new Date('2026-11-11T10:00:00Z'); // Wednesday
const TZ = 'UTC';

function recall(message: string) {
  const windows = resolveDates(message, NOW, TZ);
  return retrieveMemory({ message, windows, route: route(message, windows.length > 0), conversationId: 'current', tz: TZ });
}

describe('memory fixtures', () => {
  beforeAll(() => {
    loadFixtures(civilDateIn(NOW, TZ), TZ);
  });

  it('"On Monday we shortlisted 5 CRM tools…" recalls Mon 9 Nov with its 4 stored prices and re-checks all 5 tools', () => {
    const r = recall('On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?');
    expect(r.anchorDate).toBe('2026-11-09');
    expect(r.claims.map((c) => c.entity).sort()).toEqual(['HubSpot', 'Pipedrive', 'Salesforce', 'Zoho CRM']);
    expect(r.block).toContain('Sales Hub Starter');
    expect(r.recheck?.since).toBe('2026-11-09');
    // Freshsales was listed but never priced: still re-checked, and memory says so.
    expect(r.recheck?.queries.join(' | ')).toContain('Freshsales pricing');
    expect(r.block).toContain('No value was stored for: Freshsales');
    // Only official stored sources become search domains.
    expect(r.recheck?.domains).toEqual(expect.arrayContaining(['hubspot.com', 'salesforce.com']));
    expect(r.recheck?.domains).not.toContain('whizzbridge.com');
  });

  it('"Last Tuesday … Postgres hosting" is ambiguous and is settled by topic: 3 Nov, not the cold email on 10 Nov', () => {
    const r = recall('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?');
    expect(r.usedWindows.map((w) => w.from)).toEqual(['2026-11-03']);
    expect(r.notes.join(' ')).toContain('ambiguous');
    expect(r.block).toContain('Neon');
    expect(r.block).not.toContain('cold email');
    expect(r.baselines.map((c) => `${c.entity}`).sort()).toEqual(['Neon', 'Neon', 'Supabase']);
    expect(r.facts).toHaveLength(3); // the earlier answer's non-price statements are remembered too
    expect(r.recheck?.queries.join(' | ')).toContain('AWS RDS pricing'); // listed, no stored price
  });

  it('"What did I ask you on 3 November?" quotes the question and the earlier prices', () => {
    const r = recall('What did I ask you on 3 November? Is your answer still correct today?');
    expect(r.block).toContain('managed Postgres hosting');
    expect(r.block).toContain('$0.106');
    expect(r.block).toContain('$25');
  });

  it('a bare "last Tuesday" with no topic does not silently pick one of two different days', () => {
    const r = recall('What did I ask you last Tuesday?');
    expect(r.ambiguous?.options).toEqual(['Tue 10 Nov 2026', 'Tue 3 Nov 2026']);
    // Both candidates are recalled, and the model is told to ask which one was meant.
    expect(r.turns.map((t) => t.conversationId).sort()).toEqual(['fx-email', 'fx-postgres']);
    expect(r.notes.join(' ')).toContain('ambiguous');
    expect(r.notes.join(' ')).toContain('ask the user one short question');
    expect(r.directAnswer).toBeNull();
  });

  it('the Gemini fixture carries one stale value flagged as demo data', () => {
    const r = recall("I asked about Gemini's API price on 5 November. Did it change?");
    expect(r.anchorDate).toBe('2026-11-05');
    expect(r.block).toContain('$0.24');
    expect(r.block).toContain('DEMO DATA');
    expect(r.claims).toHaveLength(4);
  });

  it('a failed turn is remembered as a question: no answer, no values, items still re-checked', () => {
    const r = recall('On Sunday I asked about hosting platforms. Has their pricing changed since?');
    expect(r.anchorDate).toBe('2026-11-08');
    expect(r.block).toContain('No answer was given at the time');
    expect(r.block).not.toContain("Sorry, I couldn't");
    expect(r.block).toContain('No values were stored');
    expect(r.recheck?.queries).toEqual(['Vercel pricing', 'Netlify pricing', 'Cloudflare Pages pricing']);
  });

  it('a day with nothing stored abstains and lists the nearest dates instead of inventing a conversation', () => {
    const r = recall('What did I ask you on 1 November?');
    expect(r.abstained).toBe(true);
    expect(r.turns).toHaveLength(0);
    expect(r.block).toContain('No conversations found');
    expect(r.block).toMatch(/Nearest dates with conversations: .*Tue 3 Nov 2026/);
    // A pure recall request: the absence statement comes from retrieval directly.
    expect(r.directAnswer).toMatch(/I don't have any conversation with you on Sun 1 Nov 2026/);
    expect(r.directAnswer).toContain('Tue 3 Nov 2026');
  });

  it('loading twice replaces the fixtures instead of duplicating them', () => {
    loadFixtures(civilDateIn(NOW, TZ), TZ);
    const r = recall('On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?');
    expect(r.baselines).toHaveLength(4);
    expect(r.turns).toHaveLength(1);
  });
});
