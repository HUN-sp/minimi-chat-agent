import { describe, expect, it } from 'vitest';
import { decideTier, entityTokens, publisherRelation, tierFor } from '../src/search/credibility.js';
import { EvidenceRegistry, canonicalizeUrl, dedupe, normalizeDate, trimExcerpt } from '../src/search/postprocess.js';

describe('canonicalizeUrl / dedupe', () => {
  it('strips tracking params, www, hash and trailing slash', () => {
    expect(canonicalizeUrl('https://ai.google.dev/gemini-api/docs/pricing?hl=en&authuser=1#flash')).toBe('https://ai.google.dev/gemini-api/docs/pricing');
    expect(canonicalizeUrl('https://www.HubSpot.com/pricing/?utm_source=x')).toBe('https://hubspot.com/pricing');
    expect(canonicalizeUrl('https://x.com/a?b=2&a=1')).toBe('https://x.com/a?a=1&b=2');
  });

  it('dedupes the same page with different params, keeping the best score', () => {
    const out = dedupe([
      { url: 'https://ai.google.dev/pricing?hl=de', score: 0.5 },
      { url: 'https://ai.google.dev/pricing?authuser=2', score: 0.9 },
      { url: 'https://ai.google.dev/pricing', score: 0.7 },
      { url: 'https://other.com/x', score: 0.1 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].score).toBe(0.9);
  });
});

describe('trim / dates', () => {
  it('trims on a word boundary', () => {
    const t = trimExcerpt('word '.repeat(400), 100);
    expect(t.length).toBeLessThanOrEqual(101);
    expect(t.endsWith('…')).toBe(true);
  });
  it('parses Tavily dates', () => {
    expect(normalizeDate('Thu, 14 Aug 2025 13:03:58 GMT')).toBe('2025-08-14');
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeDate('garbage')).toBeNull();
  });
});

describe('tierFor', () => {
  const t = (url: string, ctx = {}) => tierFor(url, canonicalizeUrl(url), ctx);

  it('ai.google.dev is official for Gemini; costgoat is secondary', () => {
    expect(t('https://ai.google.dev/gemini-api/docs/pricing', { entities: ['Gemini'] })).toBe('official');
    expect(t('https://costgoat.com/pricing/gemini-api', { entities: ['Gemini'] })).toBe('secondary');
  });

  it('domain containing the entity is official', () => {
    expect(t('https://www.hubspot.com/pricing/sales', { entities: ['HubSpot'] })).toBe('official');
    expect(t('https://neon.com/pricing', { entities: ['Neon'] })).toBe('official');
  });

  it('a model-suggested domain is a search hint, not proof of ownership', () => {
    expect(t('https://supabase.com/pricing', { domains: ['supabase.com'] })).toBe('secondary');
    expect(t('https://supabase.com/pricing', { entities: ['Supabase'] })).toBe('official');
    expect(t('https://cheap-hosting-deals.io/supabase', { domains: ['cheap-hosting-deals.io'], entities: ['Supabase'] })).toBe('secondary');
  });

  it('a domain that merely contains the vendor name is not official', () => {
    expect(t('https://www.salesforceben.com/salesforce-pricing', { entities: ['Salesforce'] })).toBe('secondary');
    expect(t('https://hubspotpricingguide.com/starter', { entities: ['HubSpot'] })).toBe('secondary');
    expect(t('https://www.gemini.com/prices', { entities: ['Gemini 2.5 Flash'] })).toBe('secondary'); // a crypto exchange
  });

  it('official decisions carry a justification; parent companies come from an explicit table', () => {
    const d = decideTier('https://aws.amazon.com/rds/postgresql/pricing/', { entities: ['AWS RDS'] });
    expect(d.tier).toBe('official');
    expect(d.reason).toMatch(/amazon/);
    expect(d.publisherFor).toEqual(['AWS RDS']);
    expect(publisherRelation('https://blog.hubspot.com/sales/pricing', 'Salesforce')).toBeNull();
  });

  it('news outlets are reputable; aggregators never official', () => {
    expect(t('https://techcrunch.com/2026/11/05/x')).toBe('reputable');
    expect(t('https://www.g2.com/products/hubspot/pricing', { entities: ['HubSpot'] })).toBe('secondary');
    expect(t('https://randomblog.io/hubspot-review')).toBe('secondary');
  });

  it("a vendor's comparison page is not official", () => {
    expect(t('https://www.zoho.com/crm/compare/salesforce.html', { entities: ['Zoho CRM'] })).toBe('secondary');
    expect(t('https://www.pipedrive.com/en/blog/hubspot-alternatives', { entities: ['Pipedrive'] })).toBe('secondary');
    expect(t('https://neon.com/blog/neon-vs-supabase', { entities: ['Neon'] })).toBe('secondary');
    expect(t('https://neon.com/pricing', { entities: ['Neon'] })).toBe('official');
  });

  it('a comparison page is caught by its query string or title too (live neon.tech/unify regression)', () => {
    const u = 'https://neon.tech/unify?a=3058908c&n=guides%2Fneon-launch-plan-vs-supabase-pro-plan';
    expect(tierFor(u, u, { entities: ['Neon', 'Supabase'] })).toBe('secondary');
    const plain = 'https://neon.tech/unify?a=1&n=faqs%2Ffree-plan-limits-and-quotas';
    expect(tierFor(plain, plain, { entities: ['Neon'] }, 'Neon Launch vs Supabase Pro: Pricing and Features (2026)')).toBe('secondary');
    expect(tierFor(plain, plain, { entities: ['Neon'] }, 'Free plan limits and quotas')).toBe('official');
  });

  it('entity tokens skip generic words', () => {
    expect(entityTokens('Zoho CRM')).toEqual(['zoho']);
    expect(entityTokens('AWS RDS for PostgreSQL')).toEqual(['aws', 'rds']);
  });
});

describe('EvidenceRegistry', () => {
  it('assigns stable IDs and dedupes by canonical URL', () => {
    const reg = new EvidenceRegistry();
    const meta = { kind: 'general' as const, query: 'q', retrievedAt: '2026-11-11T10:00:00Z', excerptChars: 50, tierCtx: {} };
    const a = reg.add({ url: 'https://a.com/p?hl=en', title: 'A', content: 'short', score: 1 }, meta);
    const b = reg.add({ url: 'https://a.com/p', title: 'A', content: 'a much longer excerpt here', score: 1 }, meta);
    const c = reg.add({ url: 'https://b.com', title: 'B', content: 'x', score: 1 }, meta);
    expect(a.id).toBe('S1');
    expect(b.id).toBe('S1');
    expect(b.excerpt).toBe('a much longer excerpt here');
    expect(c.id).toBe('S2');
    expect([...reg.ids()]).toEqual(['S1', 'S2']);
  });
});

import { focusedSection } from '../src/search/postprocess.js';

describe('focusedSection', () => {
  const page = [
    '# Pricing',
    '## Gemini 3 Flash Preview',
    '| Input price | $0.50 |',
    '## Gemini 2.5 Flash',
    '[Standard](#s)[Batch](#b)[Flex](#f)',
    '| Input price | $0.30 |',
    '| Output price | $2.50 |',
    '## Gemini 2.5 Flash-Lite',
    '| Input price | $0.10 |',
  ].join('\n');

  it('picks the heading that best matches the query, not a near miss', () => {
    const s = focusedSection(page, 'Gemini 2.5 Flash API pricing', 500)!;
    // The section restates its full heading path, so the product name always travels with its rows.
    expect(s.startsWith('# Pricing\n## Gemini 2.5 Flash\n')).toBe(true);
    expect(s).toContain('$0.30');
    expect(s).not.toContain('$0.10');
    expect(s).not.toContain('Batch'); // link bars stripped
  });

  it('a query naming two products gets both sections', () => {
    const page2 = page + '\n## Gemini 2.5 Pro\n| Input price | $1.25 |';
    const s = focusedSection(page2, 'Gemini 2.5 Flash and Gemini 2.5 Pro pricing', 1000)!;
    expect(s).toContain('$0.30');
    expect(s).toContain('$1.25');
    expect(s).not.toContain('$0.10');
  });

  it('returns null when no heading matches', () => {
    expect(focusedSection(page, 'HubSpot Starter', 500)).toBeNull();
  });
});

describe('tierFor: plan words are not vendor names', () => {
  it('larksuite.com is not official for "Salesforce Sales Cloud Pro Suite"', () => {
    const url = 'https://www.larksuite.com/en_us/blog/zoho-crm-pricing';
    expect(tierFor(url, canonicalizeUrl(url), { entities: ['Zoho CRM', 'Pro', 'Suite', 'Enterprise'] })).toBe('secondary');
  });
});
