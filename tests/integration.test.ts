// Integration tests: the REAL turn (runTurn) with controlled providers. The model and Tavily are
// replaced by scripts; everything else runs as in production: date resolution, routing, memory
// retrieval, prefetch, source observations, the code comparison, the narrative guard, citation
// checks, persistence of answer-linked memory, and the follow-up turn that reads it back.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DB_PATH = ':memory:';
  process.env.GROQ_API_KEY = 'test-key';
  process.env.TAVILY_API_KEY = 'test-key';
});

interface Step {
  content?: string;
  toolCalls?: Record<string, unknown>[];
  delayMs?: number; // before the first chunk
  stallAfterFirstMs?: number; // after the first content chunk
  error?: unknown;
}

const llm = vi.hoisted(() => ({
  steps: [] as ((params: any) => Step)[],
  calls: [] as any[],
  json: null as null | ((messages: any, opts: any) => Promise<unknown>),
}));
const web = vi.hoisted(() => ({
  handler: null as null | ((p: any) => any[]),
  delayMs: 0,
  calls: [] as any[],
  /** Pages re-opened by URL (Tavily extract): url → markdown, or absent = could not open. */
  pages: {} as Record<string, string>,
  extracts: [] as string[][],
}));
const sleep = vi.hoisted(
  () => (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
    }),
);

vi.mock('../src/llm/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm/client.js')>();
  async function* chunks(s: Step, signal?: AbortSignal) {
    if (s.delayMs) await sleep(s.delayMs, signal);
    const pieces = s.content ? (s.content.match(/[\s\S]{1,40}/g) ?? []) : [];
    for (const [i, piece] of pieces.entries()) {
      yield { choices: [{ delta: { content: piece } }] };
      if (i === 0 && s.stallAfterFirstMs) await sleep(s.stallAfterFirstMs, signal);
    }
    for (const [i, tc] of (s.toolCalls ?? []).entries())
      yield { choices: [{ delta: { tool_calls: [{ index: i, id: `call_${i}`, function: { name: 'web_search', arguments: JSON.stringify(tc) } }] } }] };
  }
  return {
    ...actual,
    streamChat: vi.fn(async (params: any, opts: any) => {
      llm.calls.push(params);
      const step = llm.steps.shift();
      if (!step) throw new Error('no scripted model step left');
      const s = step(params);
      if (s.error) throw s.error;
      return { value: chunks(s, opts?.signal), provider: { label: 'mock-model' } };
    }),
    chatJSON: vi.fn(async (messages: any, schema: any, opts: any) => {
      if (opts?.telemetry) opts.telemetry.extractionCalls++;
      if (!llm.json) throw new Error('no scripted JSON response');
      const data = await llm.json(messages, opts);
      return { data: schema.parse(data), model: 'mock-json' };
    }),
  };
});

vi.mock('../src/search/tavily.js', () => ({
  tavilySearch: vi.fn(async (p: any, signal?: AbortSignal) => {
    web.calls.push(p);
    if (web.delayMs) await sleep(web.delayMs, signal);
    return { results: web.handler ? web.handler(p) : [], credits: 1 };
  }),
  tavilyExtract: vi.fn(async (urls: string[]) => {
    web.extracts.push(urls);
    const results = urls.filter((u) => web.pages[u]).map((u) => ({ url: u, title: `Page ${u}`, raw_content: web.pages[u] }));
    return { results, failed: urls.filter((u) => !web.pages[u]), credits: Math.ceil(results.length / 5) };
  }),
}));

import { loadFixtures } from '../scripts/fixtures.js';
import { type TurnEvent, runTurn } from '../src/agent/loop.js';
import { route } from '../src/agent/router.js';
import { config } from '../src/config.js';
import { withFallback } from '../src/llm/client.js';
import { claimsForMessages, entitySetsForMessages, getDb, getMessages } from '../src/memory/db.js';
import { retrieveMemory } from '../src/memory/retrieve.js';
import { clearCache } from '../src/search/cache.js';
import { resolveDates } from '../src/time/resolve.js';
import { civilDateIn } from '../src/time/tz.js';
import { compareClaims } from '../src/verify/reverify.js';
import { extractObservations } from '../src/evidence/observations.js';
import type { Evidence } from '../src/search/postprocess.js';

const NOW = new Date('2026-11-11T10:00:00Z'); // Wednesday
const TZ = 'UTC';

const res = (url: string, title: string, content: string, published: string | null = null) => ({ url, title, content, score: 0.9, published_date: published, raw_content: null });
const kindOf = (p: any) => (p.topic === 'news' ? 'news' : p.start_date ? 'updates' : 'primary');
/** The evidence id the model saw for a domain, read from the tool results in its prompt. */
const idOf = (params: any, domain: string): string => {
  const text = params.messages.map((m: any) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  const m = new RegExp(`\\[(S\\d+)\\][^\\n]*\\| ${domain.replace(/\./g, '\\.')} \\|`).exec(text);
  if (!m) throw new Error(`no evidence from ${domain} in the prompt`);
  return m[1];
};
const contextOf = (params: any) => params.messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');

async function turn(message: string, opts: { conversationId?: string; now?: Date; deadlineMs?: number } = {}) {
  const events: TurnEvent[] = [];
  const r = await runTurn({ message, tz: TZ, now: opts.now ?? NOW, conversationId: opts.conversationId, deadlineMs: opts.deadlineMs, emit: (e) => events.push(e) });
  return { ...r, events };
}

const CRM_WEB = (p: any) => {
  const q = p.query.toLowerCase();
  const kind = kindOf(p);
  if (kind === 'primary') {
    if (q.includes('hubspot'))
      return [res('https://www.hubspot.com/pricing/sales', 'HubSpot Sales Hub pricing', 'Sales Hub Starter: $9 per seat per month, billed annually. Sales Hub Professional: $90 per seat per month, billed annually.')];
    if (q.includes('salesforce')) return [res('https://www.salesforce.com/sales/pricing/', 'Salesforce Sales Cloud pricing', 'Starter Suite: $25 USD per user per month, billed annually.')];
    if (q.includes('zoho')) return [res('https://www.whizzbridge.com/blog/zoho-pricing', 'Zoho Pricing 2026', 'Zoho CRM Standard: $14 per user per month, billed annually.')];
    if (q.includes('pipedrive')) return [res('https://www.pipedrive.com/en/pricing', 'Pipedrive pricing', 'Essential: €14 per seat per month, billed annually.')];
    if (q.includes('freshsales')) return [res('https://www.freshworks.com/crm/pricing/', 'Freshsales pricing', 'Growth: $9 per user per month, billed annually.')];
  }
  if (kind === 'news' && q.includes('hubspot'))
    return [res('https://techcrunch.com/2026/11/10/hubspot-breeze', 'HubSpot launches Breeze AI agents for sales teams', 'The agents draft follow-ups and research prospects inside Sales Hub.', '2026-11-10')];
  return [];
};

const CRM_Q = 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?';

beforeAll(() => {
  loadFixtures(civilDateIn(NOW, TZ), TZ);
});

beforeEach(() => {
  llm.steps = [];
  llm.calls = [];
  llm.json = null;
  web.handler = null;
  web.delayMs = 0;
  web.calls = [];
  web.pages = {};
  web.extracts = [];
  clearCache();
});

afterEach(() => {
  expect(llm.steps).toHaveLength(0); // every scripted model step was used
});

describe('sample 1: CRM shortlist re-check (new conversation)', () => {
  it('renders a validated comparison in code, guards the model text, reports launches, and stores answer-linked memory', async () => {
    web.handler = CRM_WEB;
    llm.steps.push((params) => {
      // The model saw the comparison block, and the memory said the re-check already ran.
      expect(contextOf(params)).toContain('RE-CHECK DONE');
      const news = idOf(params, 'techcrunch.com');
      const fresh = idOf(params, 'freshworks.com');
      return {
        content: [
          '| CRM | Then (Mon 9 Nov) | Now | Status |',
          '|---|---|---|---|',
          '| Salesforce | $25 | $25 | Unchanged |',
          '',
          'Nothing has changed since Monday.',
          '',
          `Interpretation: HubSpot's Breeze AI agents [${news}] could save a 20-person sales team prospect-research time.`,
          '',
          `Freshsales Growth costs $9 per user per month today [${fresh}].`,
        ].join('\n'),
      };
    });

    const r = await turn(CRM_Q);
    const text = r.answer;

    // The comparison was streamed before the model wrote anything.
    const firstToken = r.events.find((e) => e.type === 'token') as { text: string };
    expect(firstToken.text).toContain('**Re-check since Mon 9 Nov 2026**');

    expect(text).toMatch(/\| HubSpot \(Sales Hub Starter\) · price \| \$9 per seat per month \(blog\.hubspot\.com\) \| \$9 per seat per month \[S\d+\][^|]*\| Unchanged \|/);
    expect(text).toMatch(/\| Salesforce \(Sales Cloud Essentials\)[^\n]*not substituted/);
    // The earlier answer's own (third-party) page states the same value today: reported, never confirmed.
    expect(text).toMatch(/\| Zoho CRM \(Standard\)[^\n]*third-party[^\n]*Can't verify: the same page the earlier answer used \(whizzbridge\.com, secondary\) states \$14 per seat per month today[^\n]*reported, not confirmed/);
    expect(text).toMatch(/\| Pipedrive \(Essential\)[^\n]*Not comparable: different currencies \(USD vs EUR\)/);
    expect(text).toMatch(/\| Freshsales \| No earlier value recorded; cannot compare\. \| – \| Not recorded \|/);
    // Verdict derived from the rows: never "nothing changed" above unverifiable rows.
    expect(text).toContain('**No price changes found among the 1 that could be checked;** 4 could not be compared.');
    expect(text).not.toContain('Nothing has changed');
    expect(text).not.toContain('Then (Mon 9 Nov)'); // the model's own Then table was dropped
    expect(text).toContain('Removed 2 statements');

    // Launches: sourced, dated, publication vs event date kept apart; absence phrased honestly.
    expect(text).toMatch(/- \*\*HubSpot\*\*: HubSpot launches Breeze AI agents for sales teams \[S\d+\] · techcrunch\.com · published Tue 10 Nov 2026; event date not stated/);
    expect(text).toContain('I found no relevant announcement in the sources checked for: Salesforce, Zoho CRM, Pipedrive, Freshsales.');
    expect(text).toContain('Interpretation: HubSpot');
    expect(text).toContain('Freshsales Growth costs $9 per user per month today');

    // Memory written before completion: linked to observations, with the user's constraint.
    const claims = claimsForMessages([r.messageId]);
    const hub = claims.find((c) => c.entity === 'HubSpot' && c.kind === 'price');
    expect(hub).toMatchObject({ status: 'supported', value: '$9', plan: 'Sales Hub Starter', unit: 'per seat', period: 'month' });
    expect(hub!.observation_id).not.toBeNull();
    expect(JSON.parse(hub!.qualifiers_json!)).toEqual({ billing: 'annual' });
    expect(claims.some((c) => c.kind === 'event' && c.entity === 'HubSpot')).toBe(true);
    const sets = entitySetsForMessages([r.messageId]);
    expect(sets.some((s) => s.constraints_json && JSON.parse(s.constraints_json).team_size === '20-person sales team')).toBe(true);
    const msg = getDb().prepare('SELECT memory_status FROM messages WHERE id = ?').get(r.messageId) as { memory_status: string };
    expect(msg.memory_status).toBe('complete');
  });

  it('works the same in the ORIGINAL conversation (same-conversation recall)', async () => {
    web.handler = CRM_WEB;
    llm.steps.push(() => ({ content: 'See the comparison above.' }));
    const r = await turn(CRM_Q, { conversationId: 'fx-crm' });
    expect(r.debug.memory.turns[0]).toMatchObject({ conversationId: 'fx-crm', sameConversation: true, date: '2026-11-09' });
    expect(r.debug.memory.anchorDate).toBe('2026-11-09');
    expect(r.answer).toContain('**Re-check since Mon 9 Nov 2026**');
  });

  it("goes back to the earlier answer's own sources: re-opens the pages it cited and searches only its websites", async () => {
    web.handler = CRM_WEB;
    // The HubSpot page the earlier answer cited, as it reads today (with its heading and table header).
    web.pages['https://blog.hubspot.com/sales/hubspot-sales-hub-pricing'] = [
      "# HubSpot's Sales Hub pricing guide",
      '## Sales Hub Starter',
      '| Plan | Price |',
      '|---|---|',
      '| Sales Hub Starter | $9 per seat per month, billed annually |',
    ].join('\n');
    llm.steps.push((params) => {
      const tool = params.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content).join('\n');
      expect(tool).toContain('The pages the earlier answer cited, opened again just now');
      expect(tool).toContain('## Sales Hub Starter\n| Plan | Price |'); // heading and table header travel with the row
      return { content: 'See the comparison above.' };
    });
    const r = await turn(CRM_Q);

    // Every page the earlier answer cited was re-opened, official sources first.
    expect(web.extracts).toHaveLength(1);
    expect(web.extracts[0]).toEqual([
      'https://blog.hubspot.com/sales/hubspot-sales-hub-pricing',
      'https://www.salesforce.com/small-business/pricing',
      'https://www.whizzbridge.com/blog/zoho-pricing',
      'https://www.stork.ai/blog/close-alternatives-2026',
    ]);
    expect(r.debug.searches.some((s: any) => s.query === 're-open 4 pages the earlier answer cited' && s.results === 1)).toBe(true);
    // Each item's current-source search is limited to the website the earlier answer used for it.
    const primary = (name: string) => web.calls.find((p) => kindOf(p) === 'primary' && p.query.includes(name));
    expect(primary('HubSpot').include_domains).toEqual(['hubspot.com']);
    expect(primary('Salesforce').include_domains).toEqual(['salesforce.com']);
    expect(primary('Zoho').include_domains).toEqual(['whizzbridge.com']);
    expect(primary('Pipedrive').include_domains).toEqual(['stork.ai']);
    // An item with no earlier source is searched normally.
    expect(primary('Freshsales').include_domains ?? []).toEqual([]);
    // The re-opened HubSpot page itself confirms the value is unchanged.
    expect(r.answer).toMatch(/\| HubSpot \(Sales Hub Starter\) · price \| \$9 per seat per month \(blog\.hubspot\.com\) \| \$9 per seat per month \[S\d+\][^|]*\| Unchanged \|/);
  });
});

describe('sample 2/3: Postgres and "what did I ask on 3 November?"', () => {
  it('the Postgres sample in its own conversation still picks 3 Nov, not the cold email', () => {
    const msg = 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?';
    const windows = resolveDates(msg, NOW, TZ);
    const m = retrieveMemory({ message: msg, windows, route: route(msg, true), conversationId: 'fx-postgres', tz: TZ });
    expect(m.usedWindows.map((w) => w.from)).toEqual(['2026-11-03']);
    expect(m.turns[0].sameConversation).toBe(true);
    expect(m.block).not.toContain('cold email');
  });

  it('price unchanged but an earlier non-price statement is no longer true: the answer is not declared current', async () => {
    web.handler = (p: any) => {
      const q = p.query.toLowerCase();
      if (kindOf(p) !== 'primary') return [];
      if (q.includes('neon'))
        return [res('https://neon.tech/pricing', 'Neon pricing', 'Launch: $0.106 per CU-hour compute, $0.35 per GB-month storage. A $5 monthly minimum now applies to the Launch plan.')];
      if (q.includes('supabase')) return [res('https://supabase.com/pricing', 'Supabase pricing', 'Pro: $25 per month per project, includes $10 in compute credits.')];
      if (q.includes('rds')) return [res('https://aws.amazon.com/rds/postgresql/pricing/', 'Amazon RDS for PostgreSQL pricing', 'db.t4g.micro: $0.016 per hour in us-east-1.')];
      return [];
    };
    llm.steps.push((params) => {
      const neon = idOf(params, 'neon.tech');
      const aws = idOf(params, 'aws.amazon.com');
      return {
        content: [
          `Correction to F1: Neon now applies a $5 monthly minimum to the Launch plan [${neon}], so "no monthly minimum" is no longer true.`,
          'Your earlier answer is still correct.',
          `AWS RDS db.t4g.micro is $0.016 per hour in us-east-1 today [${aws}].`,
        ].join('\n\n'),
      };
    });
    const r = await turn('What did I ask you on 3 November? Is your answer still correct today?');
    const text = r.answer;
    expect(text).toMatch(/Neon \(Launch\) · compute price \| \$0\.106 per CU-hour[^\n]*\| Unchanged \|/);
    expect(text).toMatch(/Supabase \(Pro\) · price \| \$25 per month[^\n]*\| Unchanged \|/);
    expect(text).toMatch(/\| AWS RDS \| No earlier value recorded; cannot compare\./);
    expect(text).toContain("non-price statements are listed below; code did not verify them");
    expect(text).toContain('**Other statements in the earlier answer**');
    expect(text).toContain('Neon: "Neon is usage-based with no monthly minimum"');
    expect(text).toContain('Correction to F1');
    expect(text).not.toContain('still correct');
    expect(text).toContain('_Coverage: compared 3 recorded prices');
  });
});

describe('recall honesty', () => {
  it('no conversation on the date: the absence statement comes from retrieval, with no model call', async () => {
    const r = await turn('What did I ask you on 1 November?');
    expect(llm.calls).toHaveLength(0);
    expect(web.calls).toHaveLength(0);
    expect(r.answer).toMatch(/^I don't have any conversation with you on Sun 1 Nov 2026/);
    expect(r.answer).toContain('Tue 3 Nov 2026');
    expect(r.debug.model).toMatch(/none/);
  });

  it('two equally plausible Tuesdays: both are handed to the model with an instruction to ask', async () => {
    llm.steps.push((params) => {
      const ctx = contextOf(params);
      expect(ctx).toContain('could mean Tue 10 Nov 2026 or Tue 3 Nov 2026');
      expect(ctx).toContain('cold email');
      expect(ctx).toContain('managed Postgres hosting');
      return { content: 'On Tue 10 Nov you asked for a cold email; on Tue 3 Nov you asked about Postgres hosting. Which Tuesday did you mean?' };
    });
    const r = await turn('What did I ask you last Tuesday?');
    expect(r.debug.memory.ambiguous.options).toHaveLength(2);
  });

  it('an earlier failed answer: the question and items are remembered, nothing is invented', async () => {
    web.handler = (p: any) =>
      kindOf(p) === 'primary' && p.query.toLowerCase().includes('vercel') ? [res('https://vercel.com/pricing', 'Vercel pricing', 'Pro: $20 per user per month.')] : [];
    llm.steps.push((params) => ({
      content: `Vercel Pro was $20 per user per month on Sunday and is unchanged [${idOf(params, 'vercel.com')}].\n\nVercel Pro costs $20 per user per month today [${idOf(params, 'vercel.com')}].`,
    }));
    const r = await turn('On Sunday I asked about hosting platforms. Has their pricing changed since?');
    expect(r.answer).toContain('| Vercel | No earlier value recorded; cannot compare.');
    expect(r.answer).toContain('**No price could be compared**');
    expect(r.answer).not.toMatch(/\bunchanged\b/i);
    expect(r.answer).not.toContain('was $20');
    expect(r.answer).toContain('Vercel Pro costs $20 per user per month today');
  });

  it('dated recall in the SAME conversation still finds the turn after more than six intervening messages', async () => {
    const conv = 'conv-long-memory';
    const mon = new Date('2026-11-09T09:00:00Z');
    web.handler = (p: any) =>
      p.query.toLowerCase().includes('hubspot') ? [res('https://www.hubspot.com/pricing/sales', 'HubSpot Sales Hub pricing', 'Sales Hub Starter: $9 per seat per month, billed annually.')] : [];
    llm.steps.push(() => ({ toolCalls: [{ queries: ['HubSpot Sales Hub Starter pricing'] }] }));
    llm.steps.push((params) => ({ content: `HubSpot Sales Hub Starter costs $9 per seat per month, billed annually [${idOf(params, 'hubspot.com')}].` }));
    const first = await turn('What does HubSpot Sales Hub Starter cost per seat?', { conversationId: conv, now: mon });
    for (let i = 0; i < 4; i++) {
      llm.steps.push(() => ({ content: "You're welcome!" }));
      await turn('thanks', { conversationId: conv, now: new Date(Date.parse('2026-11-10T09:00:00Z') + i * 60_000) });
    }
    expect(getMessages(conv).length).toBe(10);
    llm.steps.push((params) => {
      const ctx = contextOf(params);
      expect(ctx).toContain('What does HubSpot Sales Hub Starter cost per seat?');
      expect(ctx).toContain('this conversation');
      expect(ctx).toMatch(/HubSpot \[Sales Hub Starter\] price = \$9 per seat per month \(as of 2026-11-09/);
      return { content: 'On Mon 9 Nov you asked what HubSpot Sales Hub Starter costs per seat.' };
    });
    const r = await turn('What did I ask you on Monday?', { conversationId: conv });
    const firstUserId = getMessages(conv).find((m) => m.role === 'user')!.id;
    expect(r.debug.memory.turns.map((t: any) => t.userMessageId)).toContain(firstUserId);
    expect(r.debug.memory.turns[0]).toMatchObject({ sameConversation: true, inHistory: false });
    expect(first.debug.memoryWrite.supported).toBe(1);
  });
});

describe('no fabricated baseline (P0.1 acceptance)', () => {
  it('current source says $25, memory holds nothing: no recorded "Then $25" and no "Unchanged", whatever the format', async () => {
    web.handler = (p: any) => (p.query.toLowerCase().includes('supabase') ? [res('https://supabase.com/pricing', 'Supabase pricing', 'Pro: $25 per month per project.')] : []);
    llm.steps.push(() => ({ toolCalls: [{ queries: ['Supabase Pro pricing'] }] }));
    llm.steps.push((params) => {
      const s = idOf(params, 'supabase.com');
      return {
        content: [
          '| Plan | Then (1 Nov) | Now | Status |',
          '|---|---|---|---|',
          `| Supabase Pro | $25 [${s}] | $25 [${s}] | Unchanged |`,
          '',
          `Supabase Pro was $25 per month on 1 Nov and is unchanged [${s}].`,
          `- Supabase Pro: still $25 per month, no change [${s}]`,
          `Supabase Pro costs $25 per month today [${s}].`,
        ].join('\n'),
      };
    });
    const r = await turn('Has Supabase Pro pricing changed since 1 November?');
    expect(r.debug.memory.turns).toHaveLength(0);
    expect(r.answer).toContain('| Supabase Pro | not recorded | $25 [S1] |'); // the Then cell is never $25
    expect(r.answer).not.toMatch(/Supabase Pro \| \$25/);
    expect(r.answer).not.toMatch(/\bunchanged\b/i);
    expect(r.answer).not.toMatch(/no change/i);
    expect(r.answer).not.toContain('was $25');
    expect(r.answer).toContain('Supabase Pro costs $25 per month today');
  });
});

describe('answer-linked memory does not depend on formatting (P0.4)', () => {
  const SB = (p: any) => (p.query.toLowerCase().includes('hubspot') ? [res('https://www.hubspot.com/pricing/sales', 'HubSpot Sales Hub pricing', 'Sales Hub Starter: $9 per seat per month, billed annually.')] : []);
  const variants: Record<string, (s: string) => string> = {
    table: (s) => `| CRM | Plan | Price |\n|---|---|---|\n| HubSpot | Sales Hub Starter | $9 per seat per month, billed annually [${s}] |`,
    prose: (s) => `HubSpot's Sales Hub Starter plan costs $9 per seat per month, billed annually [${s}].`,
    mixed: (s) => `**HubSpot – Sales Hub Starter**\n- Price: $9 per seat/month, billed annually [${s}]`,
  };
  it('table, prose and mixed answers store the same linked assertion', async () => {
    const stored: unknown[] = [];
    for (const [name, render] of Object.entries(variants)) {
      web.handler = SB;
      llm.steps.push(() => ({ toolCalls: [{ queries: ['HubSpot Sales Hub Starter pricing'] }] }));
      llm.steps.push((params) => ({ content: render(idOf(params, 'hubspot.com')) }));
      const r = await turn('What does HubSpot Sales Hub Starter cost?', { conversationId: `fmt-${name}` });
      const prices = claimsForMessages([r.messageId]).filter((c) => c.kind === 'price');
      stored.push(prices.map(({ entity, plan, attribute, value, unit, period, status, qualifiers_json, observation_id }) => ({ entity, plan, attribute, value, unit, period, status, qualifiers_json, linked: observation_id !== null })));
    }
    expect(stored[0]).toEqual([{ entity: 'HubSpot', plan: 'Sales Hub Starter', attribute: 'price', value: '$9', unit: 'per seat', period: 'month', status: 'supported', qualifiers_json: '{"billing":"annual"}', linked: true }]);
    expect(stored[1]).toEqual(stored[0]);
    expect(stored[2]).toEqual(stored[0]);
  });
});

describe('dates stay distinct', () => {
  it('a cached source keeps its ORIGINAL fetch time; publication and fetch dates are shown separately', async () => {
    web.handler = (p: any) => [res('https://neon.tech/blog/launch-update', 'Neon launches branching v2', 'Neon launched branching v2 for all plans.', '2026-11-02')];
    const ask = (now: Date) => {
      llm.steps.push(() => ({ toolCalls: [{ queries: ['Neon branching v2 launch'] }] }));
      llm.steps.push((params) => {
        const ctx = params.messages.find((m: any) => m.role === 'tool').content as string;
        expect(ctx).toMatch(/published 2026-11-02; fetched 2026-11-11/);
        return { content: `Neon launched branching v2 [${idOf(params, 'neon.tech')}].` };
      });
      return turn('What did Neon launch recently?', { now });
    };
    const a = await ask(NOW);
    const b = await ask(new Date(NOW.getTime() + 5 * 60_000));
    expect(web.calls).toHaveLength(1); // second turn served from cache
    const fa = a.debug.searches[0].fetchedAt;
    expect(b.debug.searches[0]).toMatchObject({ cacheHit: true, fetchedAt: fa });
    const src = getDb().prepare('SELECT retrieved_at, published_at FROM sources ORDER BY id DESC LIMIT 1').get() as { retrieved_at: string; published_at: string };
    expect(src.retrieved_at).toBe(fa);
    expect(src.published_at).toBe('2026-11-02');
  });
});

describe('bounded waiting (P0.6)', () => {
  const B = config.budgets;
  const saved = { ...B };
  afterEach(() => Object.assign(B, saved));

  it('a slow search cannot extend the turn: searches stop at the phase deadline, the answer is still written', async () => {
    Object.assign(B, { answerReserveMs: 600, minSearchMs: 100 });
    web.delayMs = 10_000;
    web.handler = () => [res('https://example.com', 'x', 'y')];
    llm.steps.push(() => ({ toolCalls: [{ queries: ['Supabase Pro pricing'] }] }));
    llm.steps.push(() => ({ content: 'I could not verify the price: the search did not return in time.' }));
    const t = Date.now();
    const r = await turn('What does Supabase Pro cost?', { deadlineMs: 2000 });
    expect(Date.now() - t).toBeLessThan(2400);
    expect(r.answer).toContain('could not verify');
    expect(r.debug.searches[0].error).toMatch(/out of time/);
  });

  it('a slow model stream is cut at the deadline and the partial answer is kept, marked incomplete', async () => {
    llm.steps.push(() => ({ content: 'Supabase Pro is a flat monthly plan. More details follow about the compute credits and limits.', stallAfterFirstMs: 10_000 }));
    const t = Date.now();
    const r = await turn('Tell me about Supabase Pro plan in general terms.', { deadlineMs: 1200 });
    expect(Date.now() - t).toBeLessThan(1600);
    expect(r.answer).toContain('Supabase Pro is a flat monthly');
    expect(r.answer).toContain('Cut off at the time limit');
    expect(r.debug.deadline.timedOut).toBe(true);
  });

  it('a model that never starts: the turn ends at the deadline with an honest message', async () => {
    llm.steps.push(() => ({ content: 'late', delayMs: 10_000 }));
    const t = Date.now();
    const r = await turn('Explain what a CU-hour is.', { deadlineMs: 1000 });
    expect(Date.now() - t).toBeLessThan(1400);
    expect(r.answer).toMatch(/couldn't finish within the time limit/);
    expect(r.debug.failed).toBe(true);
  });

  it('rate limits never wait longer than the remaining budget', async () => {
    const limited = Object.assign(new Error('Rate limit reached. Please try again in 30s'), { status: 429 });
    const chain = [
      { label: 'a', baseURL: 'http://localhost:9', apiKey: 'k', model: 'a', reasoning: false },
      { label: 'b', baseURL: 'http://localhost:9', apiKey: 'k', model: 'b', reasoning: false },
    ];
    const t = Date.now();
    await expect(withFallback(chain, async () => Promise.reject(limited), { remainingMs: () => 5000 })).rejects.toBe(limited);
    expect(Date.now() - t).toBeLessThan(200); // a 30 s retry-after is not waited for

    let n = 0;
    const short = Object.assign(new Error('Please try again in 0.2s'), { status: 429 });
    const t2 = Date.now();
    const v = await withFallback(chain, async () => (n++ === 0 ? Promise.reject(short) : 'ok'), { remainingMs: () => 5000 });
    expect(v.value).toBe('ok');
    expect(Date.now() - t2).toBeGreaterThanOrEqual(200);

    // An abort during the wait ends it immediately.
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('deadline')), 50);
    const t3 = Date.now();
    const slow = Object.assign(new Error('Please try again in 3s'), { status: 429 });
    await expect(withFallback(chain, async () => Promise.reject(slow), { remainingMs: () => 10_000, signal: ctrl.signal })).rejects.toThrow('deadline');
    expect(Date.now() - t3).toBeLessThan(300);
  });

  it('slow or malformed structured extraction is bounded and never becomes a confirmation', async () => {
    const ev: Evidence = {
      id: 'S1', url: 'https://acme.com/pricing', canonicalUrl: 'https://acme.com/pricing', domain: 'acme.com', title: 'Acme pricing', excerpt: 'Our plans are listed below.', sections: [],
      publishedAt: null, retrievedAt: NOW.toISOString(), tier: 'official', kind: 'primary', query: 'acme', contentHash: 'x',
    };
    ev.observations = extractObservations(ev, ['Acme'], NOW);
    const claim = { id: 1, message_id: 1, entity: 'Acme', attribute: 'price', value: '$10', unit: null, period: 'month', plan: null, as_of: '2026-11-03', source_id: null, confidence: 0.95, demo: 0, source_tier: 'official' };

    llm.json = async () => ({ items: [{ claim_id: 1, current_value: '$10 per month', source: 'S1', quote: 'Acme costs $10 per month' }] }); // quote not in the page
    const [bad] = await compareClaims([claim], [ev], '2026-11-03', '2026-11-11', { allowModel: true, budget: {} });
    expect(bad.status).toBe('cant_verify');
    expect(bad.note).toContain('quote not found verbatim');

    llm.json = (_m, opts) => sleep(10_000, opts.signal).then(() => ({ items: [] }));
    const t = Date.now();
    const [slow] = await compareClaims([claim], [ev], '2026-11-03', '2026-11-11', { allowModel: true, budget: { signal: AbortSignal.timeout(300) } });
    expect(Date.now() - t).toBeLessThan(700);
    expect(slow.status).toBe('cant_verify');
    expect(slow.note).toContain('could not finish');
  });
});

describe('general use stays light', () => {
  it('a greeting triggers no search, no tools and no extraction', async () => {
    llm.steps.push((params) => {
      expect(params.tools).toBeUndefined();
      return { content: 'Hi! What can I look up for you?' };
    });
    const r = await turn('hi');
    expect(web.calls).toHaveLength(0);
    expect(r.debug.telemetry.extractionCalls).toBe(0);
    expect(r.debug.telemetry.searchCalls).toBe(0);
    const msg = getDb().prepare('SELECT memory_status FROM messages WHERE id = ?').get(r.messageId) as { memory_status: string };
    expect(msg.memory_status).toBe('none');
  });

  it('"what launched today?" is not a memory request: no "no conversations today" note', async () => {
    llm.steps.push((params) => {
      expect(contextOf(params)).not.toContain('No conversations found');
      expect(contextOf(params)).not.toMatch(/<memory>\n/);
      return { content: 'Let me know which product you mean.' };
    });
    // Time-sensitive: a model that answers without searching gets a code-run search, then answers again.
    llm.steps.push((params) => {
      expect(params.messages.some((m: any) => m.role === 'tool')).toBe(true);
      return { content: 'Nothing I can confirm launched today in the sources checked.' };
    });
    const r = await turn('What launched today?');
    expect(r.debug.memory.block).toBe('');
    expect(web.calls.length).toBeGreaterThan(0);
    expect(r.answer).toContain('Nothing I can confirm');
  });

  it('a user-named shortlist is remembered even without a web search', async () => {
    llm.steps.push(() => ({ content: 'Good picks: they cover different budgets.' }));
    const r = await turn('I am choosing between Linear, Jira and Asana for a 12-person engineering team.');
    const sets = entitySetsForMessages([r.messageId]);
    expect(JSON.parse(sets[0].members_json)).toEqual(['Linear', 'Jira', 'Asana']);
    expect(JSON.parse(sets[0].constraints_json!)).toMatchObject({ team_size: '12-person engineering team' });
  });
});

describe('live regressions from the 2026-11-12 manual pass', () => {
  it('#1 "3 Nov" answering our clarifying question is recalled as that date, and invented earlier values are removed', async () => {
    llm.steps.push((params) => {
      expect(contextOf(params)).toContain('is ambiguous');
      return { content: 'On Tue 10 Nov 2026 you asked for a cold email. On Tue 3 Nov 2026 you asked about managed Postgres hosting.\n\nWhich of those dates did you mean?' };
    });
    const a = await turn('What did I ask you last Tuesday?');

    llm.steps.push((params) => {
      const ctx = contextOf(params);
      expect(ctx).toContain('they mean Tue 3 Nov 2026');
      expect(ctx).toContain('managed Postgres'); // the 3 Nov turn was recalled
      expect(ctx).not.toContain('Write a 3-line cold email'); // …and only that day
      return {
        content: [
          'On Tue 3 Nov 2026 you asked what Neon, Supabase and AWS RDS charge for entry-level paid plans.',
          '',
          '**Supabase (Pro plan)**',
          '| Item | Price | Status vs 3 Nov 2026 |',
          '|---|---|---|',
          '| Base plan | $25 / month | **Same** as $25 (3 Nov) |',
          '| Additional projects | $10 / month | **Same** as $10 (3 Nov) |',
          '',
          '- AWS RDS remains unchanged from the 3 Nov snapshot.',
        ].join('\n'),
      };
    });
    const b = await turn('3 Nov', { conversationId: a.conversationId });
    expect(b.debug.route).toMatchObject({ memoryIntent: true, pureRecall: true });
    expect(b.debug.clarification).toMatchObject({ label: 'Tue 3 Nov 2026' });
    expect(b.answer).toContain('you asked what Neon, Supabase and AWS RDS charge');
    expect(b.answer).toContain('Same** as $25'); // recorded on 3 Nov: kept
    expect(b.answer).not.toContain('as $10'); // never recorded: removed
    expect(b.answer).not.toContain('remains unchanged');
    // The user's own words are what is stored for this turn.
    expect(getMessages(a.conversationId).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['What did I ask you last Tuesday?', '3 Nov']);
  });

  it('#12 "Postgres last Tuesday?" consults memory and picks the Tuesday that holds a Postgres conversation', async () => {
    llm.steps.push((params) => {
      const ctx = contextOf(params);
      expect(ctx).toContain('managed Postgres');
      expect(ctx).toContain('using Tue 3 Nov 2026 because its conversation matches the topic');
      return { content: 'On Tue 3 Nov 2026 you asked about managed Postgres hosting (Neon, Supabase, AWS RDS).' };
    });
    const r = await turn('Postgres last Tuesday?');
    expect(r.debug.route.memoryIntent).toBe(true);
  });

  it('#2 a repeated question is answered with the earlier answer in view, and a different number is surfaced in code', async () => {
    web.handler = (p: any) =>
      p.query.toLowerCase().includes('hubspot') ? [res('https://www.hubspot.com/products/crm/starter', 'HubSpot CRM Starter pricing', 'HubSpot CRM Starter: $45 per user per month, billed annually.')] : [];
    const Q = 'Shortlist 3 CRMs for a small startup.';
    const table = (price: string, id: string) => ['| CRM | Plan | Price | Source |', '|---|---|---|---|', `| HubSpot CRM | Starter | ${price} per user per month | [${id}] |`].join('\n');

    llm.steps.push((params) => {
      expect(params.tool_choice).toBe('required'); // a shortlist must be searched, never answered from training data
      return { toolCalls: [{ queries: ['HubSpot CRM Starter pricing'] }] };
    });
    llm.steps.push((params) => ({ content: table('$7', idOf(params, 'hubspot.com')) }));
    const a = await turn(Q);
    expect(a.answer).toContain('Not confirmed by the cited source'); // $7 isn't on the page

    llm.steps.push((params) => {
      expect(contextOf(params)).toContain('asked this same question before');
      return { toolCalls: [{ queries: ['HubSpot CRM Starter pricing'] }] };
    });
    llm.steps.push((params) => ({ content: table('$45', idOf(params, 'hubspot.com')) }));
    const b = await turn(Q, { conversationId: a.conversationId });
    expect(b.debug.memory.repeatOf).not.toBeNull();
    expect(b.answer).toMatch(/Different from my earlier answer[^\n]*HubSpot CRM \(Starter\) price: then \$7 per seat per month, now \$45 per seat per month/);
  });
});

describe('time-sensitive questions are always searched', () => {
  it('when the provider rejects tool_choice "required", the search runs in code and the answer is built from it', async () => {
    web.handler = (p: any) => [res('https://www.pipedrive.com/en/pricing', 'Pipedrive pricing', 'Lite: $14 per seat per month, billed annually.')];
    llm.steps.push((params) => {
      expect(params.tool_choice).toBe('required');
      return { error: Object.assign(new Error('400 tool_use_failed'), { status: 400 }) };
    });
    llm.steps.push((params) => ({ content: `Pipedrive Lite is $14 per seat per month [${idOf(params, 'pipedrive.com')}].` }));
    const r = await turn('What does Pipedrive cost per seat?');
    expect(web.calls[0].query).toBe('What does Pipedrive cost per seat?');
    expect(r.answer).toMatch(/\$14 per seat per month \[S\d+\]/);
    expect(r.answer).not.toContain('No web search ran');
  });
});
