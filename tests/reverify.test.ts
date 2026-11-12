import { describe, expect, it } from 'vitest';
import { validateCitations } from '../src/answer/citations.js';
import type { ClaimRow } from '../src/memory/db.js';
import { parseClaims } from '../src/memory/parseClaims.js';
import type { Evidence } from '../src/search/postprocess.js';
import { domainsForQuery } from '../src/search/tool.js';
import { decideTier } from '../src/search/credibility.js';
import { extractObservations } from '../src/evidence/observations.js';
import { attrKey, compareClaims, extractAndDiff, lookupCurrent, validateExtracted } from '../src/verify/reverify.js';

// The real section cut from ai.google.dev/gemini-api/docs/pricing by focusedSection().
const GEMINI_PAGE: Evidence = {
  id: 'S2',
  url: 'https://ai.google.dev/gemini-api/docs/pricing',
  canonicalUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  domain: 'ai.google.dev',
  title: 'Gemini Developer API pricing',
  tier: 'official',
  kind: 'primary',
  query: 'Gemini 2.5 Flash pricing',
  publishedAt: null,
  retrievedAt: '2026-11-11T10:00:00Z',
  contentHash: 'x',
  sections: [],
  excerpt: `## Gemini 2.5 Flash
_\`gemini-2.5-flash\`_
Our first hybrid reasoning model which supports a 1M token context window and has thinking budgets.
| | Free Tier | Paid Tier, per 1M tokens in USD |
|---|
| Input price | Free of charge | $0.30 (text / image / video) $1.00 (audio) |
| Output price (including thinking tokens) | Free of charge | $2.50 |
| Context caching price | Not available | $0.03 (text / image / video) $0.1 (audio) |
| Used to improve our products | Yes | No |
## Gemini 2.5 Pro
| | Free Tier | Paid Tier, per 1M tokens in USD |
|---|
| Input price | Free of charge | $1.25, prompts <= 200k tokens $2.50, prompts > 200k tokens |
| Output price (including thinking tokens) | Free of charge | $10.00, prompts <= 200k tokens $15.00, prompts > 200k |`,
};

const claim = (id: number, entity: string, attribute: string, value: string, extra: Partial<ClaimRow> = {}): ClaimRow => ({
  id,
  message_id: 1,
  entity,
  attribute,
  value,
  unit: 'per 1M input tokens',
  period: null,
  plan: null,
  as_of: '2026-11-05',
  source_id: 1,
  confidence: 0.95,
  demo: 0,
  source_domain: 'ai.google.dev',
  ...extra,
});

describe('attrKey', () => {
  it('matches attribute names written differently', () => {
    expect(attrKey('input_price_le_200_k_tokens')).toBe(attrKey('input_price_prompts_le_200k_tokens'));
    expect(attrKey('output_price')).toBe(attrKey('output'));
    expect(attrKey('input_price_audio')).not.toBe(attrKey('input_price_text_image_video'));
  });
});

const NOW = new Date('2026-11-11T10:00:00Z');
const withObs = (ev: Evidence, entities: string[]): Evidence => ({ ...ev, observations: extractObservations(ev, entities, NOW) });
const GEMINI = withObs(GEMINI_PAGE, ['Gemini 2.5 Flash', 'Gemini 2.5 Pro']);

describe('lookupCurrent (deterministic, no LLM): reads source observations', () => {
  it("reads the current values from the official page's own tables", () => {
    const claims = [
      claim(1, 'Gemini 2.5 Flash', 'input_price_text_image_video', '$0.24', { demo: 1 }),
      claim(2, 'Gemini 2.5 Flash', 'output_price', '$2.50'),
      claim(3, 'Gemini 2.5 Pro', 'input_price_le_200_k_tokens', '$1.25'),
      claim(4, 'Gemini 2.5 Pro', 'output_price_gt_200_k_tokens', '$15.00'),
    ];
    const value = (c: ClaimRow) => {
      const l = lookupCurrent(c, [GEMINI], '2026-11-05', '2026-11-11');
      return l.kind === 'found' ? l.obs.value : l.kind;
    };
    expect(claims.map(value)).toEqual(['$0.30', '$2.50', '$1.25', '$15.00']);
  });

  it('the demo value DIFFERS from what the page says; it is not reported as a vendor price change', async () => {
    const rows = await extractAndDiff(
      [claim(1, 'Gemini 2.5 Flash', 'input_price_text_image_video', '$0.24', { demo: 1 }), claim(2, 'Gemini 2.5 Flash', 'output_price', '$2.50', { unit: 'per 1M output tokens' })],
      [GEMINI],
      '2026-11-11',
    );
    expect(rows.map((r) => [r.claimId, r.status, r.label])).toEqual([
      [1, 'differs', 'Confirmed'],
      [2, 'unchanged', 'Confirmed'],
    ]);
    expect(rows[0].note).toContain('DEMO DATA');
    expect(rows[0].note).toContain('may correct our earlier answer');
  });

  it("a vendor change needs evidence: the vendor's own stored page said the old value", async () => {
    const stored = claim(7, 'Gemini 2.5 Flash', 'output_price', '$2.00', {
      unit: 'per 1M output tokens',
      source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
      source_excerpt: 'Gemini 2.5 Flash output price $2.00 per 1M tokens',
    });
    const [row] = await extractAndDiff([stored], [GEMINI], '2026-11-11');
    expect(row.status).toBe('changed');
    expect(row.note).toContain('it now states');
  });
});

describe('comparison semantics (P0.2)', () => {
  const page = (id: string, url: string, title: string, excerpt: string, extra: Partial<Evidence> = {}): Evidence =>
    withObs({ ...GEMINI_PAGE, id, url, canonicalUrl: url, domain: new URL(url).hostname.replace(/^www\./, ''), title, excerpt, publishedAt: null, tier: decideTier(url, { entities: ['Acme CRM'] }, title).tier, ...extra }, ['Acme CRM']);
  const acme = (extra: Partial<ClaimRow> = {}) => claim(20, 'Acme CRM', 'price', '€15', { unit: 'per seat', period: 'year', plan: 'Starter', source_url: null, source_tier: 'official', ...extra });

  it('an Enterprise monthly dollar price never validates a Starter yearly euro claim', async () => {
    const ev = page('S1', 'https://acme.com/pricing', 'Acme pricing', '## Enterprise\n| Plan | Price |\n|---|---|\n| Enterprise | $15 per seat per month |');
    const [row] = await compareClaims([acme()], [ev], '2026-11-03', '2026-11-11');
    expect(row.status).not.toBe('unchanged');
    expect(row.status).not.toBe('changed');
    expect(row.note).toMatch(/not the Starter plan|not substituted/);
  });

  it('the requested plan missing → not substituted by another plan', () => {
    const ev = page('S1', 'https://acme.com/pricing', 'Acme pricing', '| Plan | Price |\n|---|---|\n| Acme CRM Pro | €29 per seat per year |\n| Acme CRM Enterprise | €49 per seat per year |');
    const l = lookupCurrent(acme(), [ev], '2026-11-03', '2026-11-11');
    expect(l.kind).toBe('plan_missing');
  });

  it('a stored secondary source that appears again stays secondary: Reported, no verdict', async () => {
    const reddit = page('S2', 'https://www.reddit.com/r/crm/acme', 'Acme pricing thread', '| Plan | Price |\n|---|---|\n| Acme CRM Starter | €15 per seat per year |');
    const [row] = await compareClaims([acme({ source_url: 'https://www.reddit.com/r/crm/acme', source_tier: 'secondary' })], [reddit], '2026-11-03', '2026-11-11');
    expect(reddit.tier).toBe('secondary');
    expect(row.status).toBe('cant_verify');
    expect(row.label).toBe('Reported');
  });

  it('an official page published before the anchor does not establish today\'s price', async () => {
    const old = page('S3', 'https://acme.com/blog/pricing-2025', 'Acme pricing announcement', '| Plan | Price |\n|---|---|\n| Acme CRM Starter | €15 per seat per year |', { publishedAt: '2025-02-01' });
    const [row] = await compareClaims([acme()], [old], '2026-11-03', '2026-11-11');
    expect(row.status).toBe('cant_verify');
    expect(row.note).toContain('published 2025-02-01');
  });

  it('two official pages that disagree give a conflict, not a verdict', async () => {
    const a = page('S1', 'https://acme.com/pricing', 'Acme pricing', '| Plan | Price |\n|---|---|\n| Acme CRM Starter | €15 per seat per year |');
    const b = page('S4', 'https://acme.com/docs/billing', 'Acme billing docs', '| Plan | Price |\n|---|---|\n| Acme CRM Starter | €18 per seat per year |');
    const [row] = await compareClaims([acme()], [a, b], '2026-11-03', '2026-11-11');
    expect(row.status).toBe('cant_verify');
    expect(row.note).toContain('disagree');
  });

  it('values on another basis are not a conflict (live: "$0.00325 vs $60" for a $25/month claim)', async () => {
    const a = page('S1', 'https://acme.com/pricing', 'Acme pricing', '| Plan | Price |\n|---|---|\n| Acme CRM Starter | €0.00325 per hour |\n| Acme CRM Starter | €60 |');
    const [row] = await compareClaims([acme()], [a], '2026-11-03', '2026-11-11');
    expect(row.status).toBe('not_comparable');
    expect(row.note).not.toContain('disagree');
  });

  it('a third-party baseline keeps its uncertainty in the conclusion', async () => {
    const a = page('S1', 'https://acme.com/pricing', 'Acme pricing', '| Plan | Price |\n|---|---|\n| Acme CRM Starter | €15 per seat per year |');
    const [row] = await compareClaims([acme({ source_tier: 'secondary', source_domain: 'someblog.io' })], [a], '2026-11-03', '2026-11-11');
    expect(row.status).toBe('unchanged');
    expect(row.note).toContain('third-party source (someblog.io)');
  });

  it('$0.001 → $0.002 per request is a change', async () => {
    const a = page('S1', 'https://acme.com/pricing', 'Acme API pricing', '| Item | Price |\n|---|---|\n| Acme CRM | $0.002 per request |');
    const c = claim(30, 'Acme CRM', 'price', '$0.001', { unit: 'per request', period: null, plan: null, source_tier: 'official' });
    const [row] = await compareClaims([c], [a], '2026-11-03', '2026-11-11');
    expect(['changed', 'differs']).toContain(row.status);
  });
});

describe('model-extracted values are validated beyond the quote', () => {
  const c = claim(40, 'Gemini 2.5 Pro', 'input_price', '$1.25', { plan: null });
  it('the quote must be verbatim, state the value, and sit under the product', () => {
    expect(validateExtracted(c, '$1.25', 'Input price: $1.25 for Pro', GEMINI).ok).toBe(false); // not verbatim
    expect(validateExtracted(c, '$0.30', '$0.30 (text / image / video)', GEMINI).ok).toBe(false); // under Flash, not Pro
    expect(validateExtracted(c, '$1.25', '$1.25, prompts <= 200k tokens', GEMINI).ok).toBe(true);
  });
});

describe('extractAndDiff verdict rules', () => {
  it('a third-party figure is Reported, never a changed/unchanged verdict (Neon $15 → Reddit $159 regression)', async () => {
    const reddit = withObs({ ...GEMINI_PAGE, id: 'S1', url: 'https://reddit.com/r/x', domain: 'reddit.com', tier: 'secondary', title: 'Neon pricing went up?', excerpt: '## Neon Launch\n| Item | Price |\n|---|---|\n| Price | $159 per month |' }, ['Neon']);
    const rows = await extractAndDiff([claim(9, 'Neon', 'price', '$25', { unit: null, period: 'month', source_domain: 'neon.com' })], [reddit], '2026-11-11');
    expect(rows[0].status).toBe('cant_verify');
    expect(rows[0].label).toBe('Reported');
    expect(rows[0].note).toContain('reddit.com');
  });

  it('stored estimates are never diffed', async () => {
    const rows = await extractAndDiff([claim(5, 'Neon', 'estimated_cost', '$15', { confidence: 0.5 })], [GEMINI], '2026-11-11');
    expect(rows[0].status).toBe('cant_verify');
    expect(rows[0].note).toContain('estimate');
  });
});


describe('domainsForQuery', () => {
  const ds = ['blog.hubspot.com', 'microsoft.com'];
  it("restricts a query only to its own vendor's domain", () => {
    expect(domainsForQuery('HubSpot Sales Hub Professional pricing', ds)).toEqual(['blog.hubspot.com']);
    expect(domainsForQuery('Pipedrive Growth pricing', ds)).toEqual([]);
    expect(domainsForQuery('Gemini 2.5 Flash pricing', ['ai.google.dev'])).toEqual(['ai.google.dev']);
  });
});

describe('answer parsing on re-check turns', () => {
  it('skips Then/Now report tables and section labels', () => {
    const answer = `**Current verification (checked 11 Nov 2026):**

| Item | Then (3 Nov 2026) | Now (11 Nov 2026) | Status |
|---|---|---|---|
| Supabase – Pro | $25 / month [S4] | not found | Can't verify |`;
    expect(parseClaims(answer)).toEqual([]);
  });

  it('strips non-S native markers like 【diff】', () => {
    expect(validateCitations('cannot be verified today【diff】.', new Set(['S1'])).text).toBe('cannot be verified today.');
  });
});
