import { describe, expect, it } from 'vitest';
import { autoCite } from '../src/answer/autocite.js';
import { parseClaims } from '../src/memory/parseClaims.js';
import type { Evidence } from '../src/search/postprocess.js';

const ev = (id: string, domain: string, title: string, excerpt: string, tier = 'official') => ({ id, domain, title, excerpt, tier }) as Evidence;
const EVIDENCE = [
  ev('S1', 'blog.hubspot.com', 'HubSpot Sales Hub pricing', '## Sales Hub Starter Pricing\nPrice: $9/seat (billed annually)'),
  ev('S6', 'salesforce.com', 'Salesforce small business pricing', 'Pricing starts at $25 USD per user per month for Starter edition.'),
];

const ANSWER = `| CRM | Main sales plan | Price per seat/month | Source |
|-----|-----------------|----------------------|--------|
| HubSpot | Starter | **$9** | HubSpot pricing guide |
| Salesforce | Starter | **$25** | Salesforce pricing page |
| Zoho CRM | Standard | **$12** | Zoho pricing page |

| CRM | 20 seats | Total annual cost |
|-----|----------|-------------------|
| HubSpot | 20 × $9 = $180/month | $2,160 |`;

describe('autoCite', () => {
  it('adds a citation only where code can prove the source states the value for that product', () => {
    const { text, added } = autoCite(ANSWER, EVIDENCE);
    expect(added).toBe(2);
    expect(text).toContain('**$9** [S1]');
    expect(text).toContain('**$25** [S6]');
    expect(text).not.toMatch(/\$12\*\* \[S/); // no source states Zoho's price
    expect(text).not.toMatch(/2,160 \[S/); // computed column
  });

  it('computed columns are not parsed as claims', () => {
    const claims = parseClaims(ANSWER);
    expect(claims.map((c) => `${c.entity} ${c.value}`)).toEqual(['HubSpot $9', 'Salesforce $25', 'Zoho CRM $12']);
  });

  it('leaves already-cited answers untouched', () => {
    const cited = '| X | Price |\n|---|---|\n| HubSpot | $9 [S1] |';
    expect(autoCite(cited, EVIDENCE)).toEqual({ text: cited, added: 0 });
  });
});

import { enforceLabels } from '../src/answer/labels.js';

describe('enforceLabels', () => {
  const evs = [ev('S1', 'aws.amazon.com', 'RDS pricing', 'x'), ev('S3', 'reddit.com', 'thread', 'x', 'secondary')];
  it('keeps Confirmed only with an official citation on the line', () => {
    const text = [
      '| AWS RDS | $13 | **Confirmed** [S1] |',
      '| AWS RDS | $13 | **Confirmed** – pricing page unchanged (no new source needed) |',
      '| Supabase | $25 | **Confirmed** [S3] |',
    ].join('\n');
    const r = enforceLabels(text, evs);
    expect(r.downgraded).toBe(2);
    expect(r.text.split('\n')).toEqual([
      '| AWS RDS | $13 | **Confirmed** [S1] |',
      '| AWS RDS | $13 | **Unverified (no source this turn)** – pricing page unchanged (no new source needed) |',
      '| Supabase | $25 | **Reported** [S3] |',
    ]);
  });
});
