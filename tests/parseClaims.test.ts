import { describe, expect, it } from 'vitest';
import { parseClaims } from '../src/memory/parseClaims.js';
import type { Evidence } from '../src/search/postprocess.js';
import { supportedBy } from '../src/verify/support.js';

// Real answers produced by the agent during seeding (trimmed).
const GEMINI = `**Gemini 2.5 Flash** – Standard tier
- Input: **$0.30 / 1 M tokens** (text / image / video) – **Confirmed** (official pricing page, checked 5 Nov 2026)[S2]
- Output (including thinking tokens): **$2.50 / 1 M tokens** – **Confirmed**[S2]

**Gemini 2.5 Pro** – Standard tier (no free tier)
- Input: **$0.30 / 1 M tokens** (text / image / video) – **Confirmed**[S2]`;

const CRM = `**Per-seat monthly price (billed annually) for the main sales plan of each shortlisted CRM**

| CRM | Main sales plan | Price per seat | Source |
|-----|-----------------|----------------|--------|
| HubSpot | Sales Hub Starter | **$9** | [S1] |
| Salesforce | Sales Cloud Starter | **$25** | [S6] |

*All prices are per user per month when billed annually.*`;

const POSTGRES = `**Neon – Launch (entry-level paid) ≈ $20 / month** – usage based, a small workload costs about **$20 /month**[S1][S5].

**Supabase – Pro plan = $25 / month** – flat **$25 per month** per project[S6].

| Provider | Entry-level paid plan | Monthly cost (approx.) | What's included |
|----------|----------------------|------------------------|-----------------|
| Supabase | Pro | **$25** [S6] | Daily backups, $10 compute credit |`;

const FEATURE_TABLE = `### Gemini 2.5 Flash
| Feature | Paid tier (per 1M tokens) |
|---|---|
| Text input | $0.30 [S1] |
| Text output | $2.50 [S1] |`;

describe('parseClaims', () => {
  it('bullets under a product line', () => {
    const c = parseClaims(GEMINI);
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({ entity: 'Gemini 2.5 Flash', plan: 'Standard tier', attribute: 'input', value: '$0.30', unit: 'per 1M input tokens', sources: ['S2'] });
    expect(c[2]).toMatchObject({ entity: 'Gemini 2.5 Pro', attribute: 'input', value: '$0.30' });
  });

  it('comparison table with plan and source columns', () => {
    const c = parseClaims(CRM);
    expect(c).toEqual([
      expect.objectContaining({ entity: 'HubSpot', plan: 'Sales Hub Starter', attribute: 'price', value: '$9', unit: 'per seat', sources: ['S1'] }),
      expect.objectContaining({ entity: 'Salesforce', plan: 'Sales Cloud Starter', value: '$25', sources: ['S6'] }),
    ]);
  });

  it('bold lead lines; estimates are flagged; note columns ignored', () => {
    const c = parseClaims(POSTGRES);
    const neon = c.find((x) => x.entity === 'Neon')!;
    expect(neon).toMatchObject({ plan: 'Launch (entry-level paid)', value: '$20', period: 'month', approximate: true, attribute: 'estimated_cost' });
    const supa = c.filter((x) => x.entity === 'Supabase');
    expect(supa).toHaveLength(1);
    expect(supa[0]).toMatchObject({ value: '$25', approximate: false, sources: ['S6'] });
    expect(c.some((x) => x.value === '$10')).toBe(false); // "What's included" column
  });

  it('feature-row tables take the product from the heading above', () => {
    const c = parseClaims(FEATURE_TABLE);
    expect(c.map((x) => [x.entity, x.attribute, x.value])).toEqual([
      ['Gemini 2.5 Flash', 'text_input', '$0.30'],
      ['Gemini 2.5 Flash', 'text_output', '$2.50'],
    ]);
  });

  it('"Token type" tables are attribute rows under the product heading (seed regression)', () => {
    const answer = `**Gemini 2.5 Flash (paid tier)**

| Token type | Price per 1 M tokens | Source |
|------------|----------------------|--------|
| Input (text / image / video) | **$0.30** | [S1] |
| Output (including thinking tokens) | **$2.50** | [S1] |`;
    const c = parseClaims(answer);
    expect(c.map((x) => [x.entity, x.attribute, x.value])).toEqual([
      ['Gemini 2.5 Flash', 'input', '$0.30'],
      ['Gemini 2.5 Flash', 'output', '$2.50'],
    ]);
  });

  it('unicode hyphens, bullets without colons, several prices in one cell (seed regression)', () => {
    const answer = `**Neon – “Launch” (entry‑level paid) :** Pay‑as‑you‑go.
- Compute $0.106 per CU‑hour [S3]
- Storage $0.35 per GB‑month [S3]

| Provider | Plan | Pricing |
|---|---|---|
| Neon | Launch | $0.106 /CU‑hour · $0.35 / GB‑month [S3] |`;
    const c = parseClaims(answer);
    expect(c.map((x) => [x.entity, x.attribute, x.value, x.unit])).toEqual([
      ['Neon', 'compute', '$0.106', 'per CU-hour'],
      ['Neon', 'storage', '$0.35', 'per GB-month'],
    ]);
  });

  it('several prices in one cell keep their qualifiers and the header unit (seed regression)', () => {
    const answer = `### Gemini 2.5 Pro
| Token type | Price per 1M tokens |
|---|---|
| Input | $1.25 (prompts <= 200k tokens) · $2.50 (prompts > 200k tokens) [S1] |`;
    const c = parseClaims(answer);
    expect(c.map((x) => [x.attribute, x.value, x.unit])).toEqual([
      ['input_prompts_le_200k_tokens', '$1.25', 'per 1M tokens'],
      ['input_prompts_gt_200k_tokens', '$2.50', 'per 1M tokens'],
    ]);
  });

  it('a sub-heading under a product is its plan, not a new product', () => {
    const page = '## Gemini 2.5 Flash\n### Standard\n| Token type | Paid tier (per 1M tokens) |\n|---|---|\n| Input | $0.30 |\n### Batch\n| Token type | Paid tier (per 1M tokens) |\n|---|---|\n| Input | $0.15 |';
    const claims = parseClaims(page);
    expect(claims.map((c) => [c.entity, c.plan, c.value])).toEqual([
      ['Gemini 2.5 Flash', 'Standard', '$0.30'],
      ['Gemini 2.5 Flash', 'Batch', '$0.15'],
    ]);
  });

  it('ignores prose without structure', () => {
    expect(parseClaims('For 20 seats that is 20 × $9 = $180 a month.')).toEqual([]);
  });
});

describe('supportedBy', () => {
  const ev = {
    id: 'S2',
    title: 'Gemini Developer API pricing',
    domain: 'ai.google.dev',
    excerpt: '## Gemini 2.5 Flash\n| Input price | $0.30 |\n| Output price | $2.50 |\n## Gemini 2.5 Pro\n| Input price | $1.25 |',
  } as Evidence;

  it('accepts a value under the right product heading', () => {
    expect(supportedBy('$0.30', 'Gemini 2.5 Flash', ev).ok).toBe(true);
    expect(supportedBy('$1.25', 'Gemini 2.5 Pro', ev).ok).toBe(true);
  });

  it("rejects another product's price (the seeding bug)", () => {
    const s = supportedBy('$0.30', 'Gemini 2.5 Pro', ev);
    expect(s.ok).toBe(false);
    expect(s.reason).toContain('Gemini 2.5 Flash');
  });

  it('rejects a value that is not in the source', () => {
    expect(supportedBy('$0.50', 'Gemini 2.5 Flash', ev).ok).toBe(false);
  });

  it('a price under a nested tier heading belongs to the product above it (live Gemini false-warning regression)', () => {
    const nested = {
      id: 'S1',
      title: 'Gemini Developer API pricing',
      domain: 'ai.google.dev',
      excerpt:
        '## Gemini 2.5 Flash\nOur hybrid reasoning model.\n### Standard\n| | Paid Tier |\n|---|---|\n| Input price | $0.30 |\n### Batch\n| Input price | $0.15 |\n' +
        '…\n## Gemini 2.5 Pro\n### Standard\n| Input price | $1.25 |\n| Output price | $10.00 |',
    } as Evidence;
    expect(supportedBy('$0.30', 'Gemini 2.5 Flash', nested).ok).toBe(true);
    expect(supportedBy('$1.25', 'Gemini 2.5 Pro', nested).ok).toBe(true);
    expect(supportedBy('$10.00', 'Gemini 2.5 Pro', nested).ok).toBe(true);
    // Still catches the cross-product misattribution the check exists for.
    const wrong = supportedBy('$0.30', 'Gemini 2.5 Pro', nested);
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toContain('Gemini 2.5 Flash › Standard');
  });

  it('uses domain/title for vendor pages without product headings', () => {
    const hub = { id: 'S1', title: 'HubSpot Sales Hub pricing', domain: 'blog.hubspot.com', excerpt: '## Sales Hub Starter Pricing\nPrice: $9/seat (billed annually)' } as Evidence;
    expect(supportedBy('$9', 'HubSpot', hub).ok).toBe(true);
    expect(supportedBy('$9', 'Pipedrive', hub).ok).toBe(false);
  });
});
