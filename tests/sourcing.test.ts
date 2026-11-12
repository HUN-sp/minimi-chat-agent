// Excerpts that keep a price with its product, the freshness rule for "today's price", re-checks that
// go back to the earlier answer's own sources, and the Confirmed label tied to what the source states.

import { describe, expect, it } from 'vitest';
import { isStale, pageKind, tooOldForNow } from '../src/answer/freshness.js';
import { markUnconfirmed } from '../src/answer/labels.js';
import { extractObservations } from '../src/evidence/observations.js';
import type { ClaimRow } from '../src/memory/db.js';
import { EvidenceRegistry, type Evidence, chunkLines, focusedChunks, snippetChunks } from '../src/search/postprocess.js';
import { supportedBy } from '../src/verify/support.js';
import { buildRecheckPlan, buildRow, lookupCurrent } from '../src/verify/reverify.js';

const TODAY = '2026-11-12';
const NOW = new Date(`${TODAY}T06:00:00Z`);

function ev(id: string, url: string, title: string, excerpt: string, publishedAt: string | null = null): Evidence {
  return { id, url, canonicalUrl: url, domain: new URL(url).hostname.replace(/^www\./, ''), title, excerpt, sections: [excerpt], publishedAt, retrievedAt: `${TODAY}T06:00:00Z`, tier: 'official', kind: 'general', query: '', contentHash: id };
}
function claim(p: Partial<ClaimRow>): ClaimRow {
  return { id: 1, message_id: 1, entity: 'X', attribute: 'price', value: '$1', unit: null, period: null, plan: null, as_of: '2026-11-09', source_id: 1, confidence: 0.95, demo: 0, kind: 'price', status: 'supported', ...p };
}

// The shape of ai.google.dev's pricing page: products as headings, tiers as tables with a header row.
const GEMINI_PAGE = [
  '# Gemini Developer API pricing',
  '## Gemini 2.5 Flash',
  '_`gemini-2.5-flash`_',
  '| | Free Tier | Paid Tier, per 1M tokens in USD |',
  '|---|---|---|',
  '| Input price | Free of charge | $0.30 (text / image / video) |',
  '| Output price (including thinking tokens) | Free of charge | $2.50 |',
  '## Gemini 2.5 Flash Native Audio',
  '| | Free Tier | Paid Tier, per 1M tokens in USD |',
  '|---|---|---|',
  '| Input price | Free of charge | $2.00 or $0.003/min (audio) |',
  '| Output price (including thinking tokens) | Free of charge | $12.00 or $0.002/min (text) |',
].join('\n');

describe('excerpts keep every price with its product and its table header', () => {
  it('a long table is split into chunks that EACH repeat the heading path and the header row', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| Model ${i} | $${i}.00 per 1M tokens |`);
    const lines = ['# Pricing', '## Batch tier', '| Model | Paid tier |', '|---|---|', ...rows];
    const chunks = chunkLines(lines, 1, lines.length, [{ level: 1, text: 'Pricing' }], 300);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.startsWith('# Pricing\n## Batch tier\n| Model | Paid tier |\n|---|\n')).toBe(true);
    // Every row survives, exactly once: nothing is cut away.
    for (const r of rows) expect(chunks.filter((c) => c.includes(r))).toHaveLength(1);
  });

  it('a heading inside a list item counts ("* ### Launch"), and the product name comes from the heading PATH', () => {
    const page = ['# Neon pricing', '## Neon pricing plans', '* ### Free', '  #### $0', '  Build and learn free.', '* ### Launch', '  #### $0.106 / CU-hour', '  For startups.', '* ### Scale', '  #### $0.222 / CU-hour'].join('\n');
    const chunks = focusedChunks(page, 'Neon Launch pricing', 1200)!;
    const text = chunks.join('\n');
    expect(text.startsWith('# Neon pricing\n## Neon pricing plans\n### Launch')).toBe(true);
    expect(text).toContain('$0.106');
    expect(text).not.toContain('$0.222');
    expect(text).not.toContain('$0 \n');
  });

  it('when no heading matches the query, the section the search snippet came from is restored with its heading', () => {
    // Live regression: this snippet, with no model name, became "Gemini 2.5 Flash: $2.00, Confirmed".
    const snippet = '| Input price | Free of charge | $2.00 or $0.003/min (audio) | [...] | Output price (including thinking tokens) | Free of charge | $12.00 or $0.002/min (text) |';
    expect(focusedChunks(GEMINI_PAGE, 'Google Gemini API pricing per 1M tokens input', 1200)).toBeNull();
    const chunks = snippetChunks(GEMINI_PAGE, snippet, 1200)!;
    expect(chunks[0]).toContain('## Gemini 2.5 Flash Native Audio\n| | Free Tier | Paid Tier, per 1M tokens in USD |');
    expect(chunks[0]).toContain('$2.00');
    // …so the code check now knows $2.00 is NOT a Gemini 2.5 Flash price.
    const e = ev('S2', 'https://ai.google.dev/gemini-api/docs/pricing', 'Gemini Developer API pricing', chunks.join('\n…\n'));
    expect(supportedBy('$2.00', 'Gemini 2.5 Flash', e).ok).toBe(false);
    expect(supportedBy('$2.00', 'Gemini 2.5 Flash Native Audio', e).ok).toBe(true);
  });

  it('the registry builds excerpts from the page, and only falls back to a marked snippet without one', () => {
    const reg = new EvidenceRegistry();
    const meta = { kind: 'general' as const, query: 'Google Gemini API pricing per 1M tokens input', retrievedAt: `${TODAY}T06:00:00Z`, excerptChars: 1200, chunkChars: 1200, tierCtx: {} };
    const snippet = '| Input price | Free of charge | $2.00 or $0.003/min (audio) |';
    const withPage = reg.add({ url: 'https://ai.google.dev/gemini-api/docs/pricing', title: 'Gemini Developer API pricing', content: snippet, score: 1, raw_content: GEMINI_PAGE }, meta);
    expect(withPage.fromPage).toBe(true);
    expect(withPage.excerpt).toContain('## Gemini 2.5 Flash Native Audio');
    const bare = reg.add({ url: 'https://example.com/gemini', title: 'Gemini prices', content: snippet, score: 1 }, meta);
    expect(bare.excerpt.startsWith('(Part of a table whose heading was not returned')).toBe(true);
  });
});

describe("freshness: a live pricing page shows today's price; an old article does not", () => {
  const pricing = (publishedAt: string | null) => ev('S1', 'https://www.hubspot.com/pricing/crm', 'HubSpot CRM pricing', '| Plan | Price |\n|---|---|\n| HubSpot Sales Hub Starter | $9 per seat per month |', publishedAt);
  const blog = (publishedAt: string) => ev('S2', 'https://blog.hubspot.com/sales/hubspot-sales-hub-pricing', 'HubSpot Sales Hub pricing guide', '| Plan | Price |\n|---|---|\n| HubSpot Sales Hub Starter | $9 per seat per month |', publishedAt);

  it('tells live pages from articles', () => {
    expect(pageKind(pricing(null))).toBe('live');
    expect(pageKind({ url: 'https://ai.google.dev/gemini-api/docs/pricing' })).toBe('live');
    expect(pageKind({ url: 'https://support.pipedrive.com/en/article/new-pipedrive-plans' })).toBe('live');
    expect(pageKind(blog('2026-09-09'))).toBe('article');
    expect(pageKind({ url: 'https://neon.tech/unify?n=blog%2Fnew-usage-based-pricing' })).toBe('article');
    expect(pageKind({ url: 'https://www.salesforce.com/news/stories/agentforce' })).toBe('article');
    expect(pageKind({ url: 'https://techcrunch.com/2026/11/10/hubspot-breeze' })).toBe('article');
  });

  it('a pricing page last updated in April still gives today\'s price (re-check from 9 Nov): Unchanged', () => {
    const page = pricing('2026-04-02');
    const c = claim({ entity: 'HubSpot', plan: 'Sales Hub Starter', value: '$9', unit: 'per seat', period: 'month', source_tier: 'official', source_url: 'https://www.hubspot.com/pricing/crm' });
    const l = lookupCurrent(c, [{ ...page, observations: extractObservations(page, ['HubSpot'], NOW) }], '2026-11-09', TODAY);
    expect(l.kind).toBe('found');
    const row = buildRow(c, l, '2026-11-09', TODAY);
    expect(row.status).toBe('unchanged');
    expect(row.note).toContain('last updated 2026-04-02');
    expect(isStale(page, TODAY)).toBe(false);
  });

  it('an ARTICLE published before the anchor still cannot say what the price is today', () => {
    const post = blog('2026-09-09');
    expect(tooOldForNow(post, '2026-11-09', TODAY)).toBe(true);
    const c = claim({ entity: 'HubSpot', plan: 'Sales Hub Starter', value: '$9', unit: 'per seat', period: 'month' });
    const l = lookupCurrent(c, [{ ...post, observations: extractObservations(post, ['HubSpot'], NOW) }], '2026-11-09', TODAY);
    expect(l.kind).toBe('stale');
    expect(buildRow(c, l, '2026-11-09', TODAY).note).toContain('article published 2026-09-09');
  });

  it('a pricing page not updated for over a year is treated as possibly outdated', () => {
    const page = pricing('2025-06-01');
    expect(tooOldForNow(page, '2026-11-09', TODAY)).toBe(true);
    expect(isStale(page, TODAY)).toBe(true);
    const c = claim({ entity: 'HubSpot', plan: 'Sales Hub Starter', value: '$9', unit: 'per seat', period: 'month' });
    const l = lookupCurrent(c, [{ ...page, observations: extractObservations(page, ['HubSpot'], NOW) }], '2026-11-09', TODAY);
    expect(buildRow(c, l, '2026-11-09', TODAY).note).toContain('over a year ago');
  });
});

describe('reading re-opened pages (live run, 12 Nov 2026)', () => {
  const page = (url: string, title: string, raw: string, query: string) =>
    new EvidenceRegistry().add({ url, title, content: '', score: 1, raw_content: raw, published_date: null }, { kind: 'primary', query, retrievedAt: `${TODAY}T06:00:00Z`, excerptChars: 1200, chunkChars: 1200, tierCtx: {}, reread: true });
  const obsOf = (e: Evidence, entities: string[]) => (e.observations = extractObservations(e, entities, NOW));

  // whizzbridge.com/blog/zoho-pricing as re-read on 12 Nov 2026 (verbatim).
  const ZOHO =
    '## Zoho CRM Plans & Pricing\n**Standard Plan**Priced at $14/month (annual billing) or $20/month (monthly billing), the Standard plan introduces key tools like mass email capabilities, scoring rules, and sales forecasting.';

  // The shape of neon.tech/pricing: plan cards as headings in list items, prices on plain lines.
  const NEON = [
    '# Neon pricing',
    '## Neon pricing plans',
    '* ### Launch',
    '  #### Usage-based',
    '  Typical spend: $15 /mo',
    '  + $0.106 per CU-hr',
    '  + $0.35 per GB-month',
    '## Plan details',
    '### Launch',
    '+ $0.35 per GB-month',
    '+ $0.20 per GB-month based on volume of data changes during your selected history window',
    '+ 100 snapshots $0.09/GB-month',
    '+ $0.023 per GB-month',
  ].join('\n');

  it("Launch's own price under a deeper heading (Launch › Usage-based) matches the stored Launch plan, and the unit names the attribute", () => {
    const e = page('https://neon.tech/pricing', 'Neon pricing', NEON, 'Neon Launch pricing');
    obsOf(e, ['Neon']);
    const compute = claim({ entity: 'Neon', plan: 'Launch', attribute: 'compute_price', value: '$0.106', unit: 'per CU-hour', source_url: 'https://neon.tech/pricing', source_tier: 'official' });
    const l = lookupCurrent(compute, [e], '2026-11-03', TODAY);
    expect(l.kind).toBe('found');
    expect(buildRow(compute, l, '2026-11-03', TODAY).status).toBe('unchanged');
  });

  it('one page listing several GB-month prices for the plan still states our exact value: Unchanged, not "sources disagree"', () => {
    const e = page('https://neon.tech/pricing', 'Neon pricing', NEON, 'Neon Launch pricing');
    obsOf(e, ['Neon']);
    const storage = claim({ entity: 'Neon', plan: 'Launch', attribute: 'storage_price', value: '$0.35', unit: 'per GB-month', source_url: 'https://neon.tech/pricing', source_tier: 'official' });
    const row = buildRow(storage, lookupCurrent(storage, [e], '2026-11-03', TODAY), '2026-11-03', TODAY);
    expect(row.status).toBe('unchanged');
    // Lines with more description are other charges in the same unit, not "storage price".
    const storageObs = (e.observations ?? []).filter((o) => o.attribute === 'storage_price').map((o) => o.value);
    expect(storageObs).not.toContain('$0.20');
    expect(storageObs).not.toContain('$0.09');
  });

  it('two DIFFERENT official pages with different values are still a conflict', () => {
    const a = page('https://neon.tech/pricing', 'Neon pricing', '## Launch\n+ $0.35 per GB-month', 'Neon Launch pricing');
    const b = page('https://neon.tech/docs/introduction/plans', 'Neon plans', '## Launch\n+ $0.30 per GB-month', 'Neon Launch pricing');
    b.id = 'S2';
    obsOf(a, ['Neon']);
    obsOf(b, ['Neon']);
    const storage = claim({ entity: 'Neon', plan: 'Launch', attribute: 'storage_price', value: '$0.35', unit: 'per GB-month' });
    expect(lookupCurrent(storage, [a, b], '2026-11-03', TODAY).kind).toBe('conflict');
  });

  it('an article\'s sentence-like headings are not plan names; bold text is not glued to the next word', () => {
    const stork = page(
      'https://www.stork.ai/blog/close-alternatives-2026',
      'Close Alternatives (2026)',
      '# Close Alternatives (2026)\n## Close alternatives at a glance\nPipedrive starts at $14 per seat per month.\n## What a 5-seat team pays for follow-up automation\nPipedrive costs $24 per seat per month on monthly billing.',
      'Pipedrive Essential pricing',
    );
    for (const o of obsOf(stork, ['Pipedrive']).filter((o) => o.kind === 'price')) expect(o.plan).toBeNull();
    const zoho = page('https://www.whizzbridge.com/blog/zoho-pricing', 'Zoho Pricing', ZOHO, 'Zoho CRM Standard pricing');
    expect(zoho.excerpt).toContain('**Standard Plan**Priced');
    expect(obsOf(zoho, ['Zoho CRM']).some((o) => o.plan === 'Standard' && o.value === '$14')).toBe(true);
  });

  it("re-reading the earlier answer's own third-party page says so, and stays Reported", () => {
    const zoho = page('https://www.whizzbridge.com/blog/zoho-pricing', 'Zoho Pricing', ZOHO, 'Zoho CRM Standard pricing');
    zoho.tier = 'secondary';
    // "Zoho" (from the search query) and "Zoho CRM" (from memory) are both in play: one vendor, not a tie.
    obsOf(zoho, ['Zoho CRM', 'Zoho', 'Pipedrive']);
    const c = claim({ entity: 'Zoho CRM', plan: 'Standard', value: '$14', period: 'month', source_url: 'https://www.whizzbridge.com/blog/zoho-pricing', source_tier: 'secondary', source_domain: 'whizzbridge.com' });
    const row = buildRow(c, lookupCurrent(c, [zoho], '2026-11-09', TODAY), '2026-11-09', TODAY);
    expect(row.label).toBe('Reported');
    expect(row.note).toContain('the same page the earlier answer used (whizzbridge.com, secondary)');
  });
});

describe('re-check plan: back to the earlier answer\'s own sources', () => {
  it("lists the pages it cited and, per item, the websites it used (blog.hubspot.com → hubspot.com)", () => {
    const plan = buildRecheckPlan(
      [
        claim({ id: 1, entity: 'HubSpot', plan: 'Sales Hub Starter', source_url: 'https://blog.hubspot.com/sales/hubspot-sales-hub-pricing', source_domain: 'blog.hubspot.com', source_tier: 'official' }),
        claim({ id: 2, entity: 'Zoho CRM', plan: 'Standard', source_url: 'https://www.whizzbridge.com/blog/zoho-pricing', source_domain: 'whizzbridge.com', source_tier: 'secondary' }),
      ],
      '2026-11-09',
      ['Freshsales'],
    )!;
    expect(plan.sites).toEqual({ 'HubSpot Sales Hub Starter pricing': ['hubspot.com'], 'Zoho CRM Standard pricing': ['whizzbridge.com'] });
    expect(plan.pages.map((p) => p.url)).toEqual(['https://blog.hubspot.com/sales/hubspot-sales-hub-pricing', 'https://www.whizzbridge.com/blog/zoho-pricing']);
    expect(plan.queries).toContain('Freshsales pricing');
    expect(plan.sites['Freshsales pricing']).toBeUndefined();
  });
});

describe('the Confirmed label needs the cited source to state the value', () => {
  it('withdraws Confirmed on the line whose value the check could not find in the cited source', () => {
    const text = [
      '| Input tokens | $2.00 | **Confirmed** – ai.google.dev [S2] |',
      '| Output tokens | $2.50 | **Confirmed** – ai.google.dev [S1] |',
    ].join('\n');
    const r = markUnconfirmed(text, [{ value: '$2.00', ids: ['S2'] }]);
    expect(r.downgraded).toBe(1);
    expect(r.text.split('\n')[0]).toContain("**Not confirmed** (the cited source doesn't state this value)");
    expect(r.text.split('\n')[1]).toContain('**Confirmed**');
  });
});
