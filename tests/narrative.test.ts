// The model-text guard on re-check turns. Cases come from a live run (12 Nov 2026) where the model
// contradicted the code comparison in prose.

import { describe, expect, it } from 'vitest';
import { guardNarrative } from '../src/answer/narrative.js';
import type { ClaimRow } from '../src/memory/db.js';
import { parseClaims } from '../src/memory/parseClaims.js';
import { type Comparison, type DiffRow, notRecordedRow } from '../src/verify/reverify.js';

const row = (entity: string, status: DiffRow['status'], then: string | null): DiffRow => ({
  ...notRecordedRow(entity, '2026-11-12'),
  claimId: then ? 1 : null,
  status,
  then: { value: then, asOf: '2026-11-09', source: null, sourceTier: 'official', demo: false, messageId: 1, qualifiers: {} },
});
const comp = (rows: DiffRow[], facts: Comparison['facts'] = []): Comparison => ({ anchor: '2026-11-09', checked: '2026-11-12', rows, events: [], undatedEvents: 0, facts, coverage: {}, launches: false, entities: rows.map((r) => r.entity) });
const recorded = [{ entity: 'HubSpot', value: '$9', unit: 'per seat', period: 'month' }] as ClaimRow[];

describe('guardNarrative', () => {
  it('removes a per-item verdict that contradicts its row (live: "still lists $9 … remains accurate" on a Can\'t verify row)', () => {
    const text = "- HubSpot's $9 per seat price was previously confirmed; today's official page still lists $9 per seat / month, so the earlier claim remains accurate [S1].";
    const g = guardNarrative(text, comp([row('HubSpot', 'cant_verify', '$9 per seat per month')]), recorded);
    expect(g.removed).toHaveLength(1);
    expect(g.text).not.toContain('remains accurate');
  });

  it('keeps the same verdict when the row really is Unchanged', () => {
    const text = 'HubSpot still lists $9 per seat per month [S1].';
    expect(guardNarrative(text, comp([row('HubSpot', 'unchanged', '$9 per seat per month')]), recorded).removed).toHaveLength(0);
  });

  it('a blanket "still correct" is removed while earlier non-price statements are unverified', () => {
    const c = comp([row('Neon', 'unchanged', '$0.106 per CU-hour')], [{ id: 'F1', claimId: 2, entity: 'Neon', text: 'no monthly minimum', asOf: '2026-11-03' }]);
    expect(guardNarrative('Your earlier answer is still correct.', c, []).text).not.toContain('still correct');
  });

  it('an earlier value survives only if it is a stored assertion for the item named', () => {
    const c = comp([row('HubSpot', 'unchanged', '$9 per seat per month')]);
    expect(guardNarrative('On Monday HubSpot was $9 per seat.', c, recorded).removed).toHaveLength(0);
    expect(guardNarrative('On Monday HubSpot was $12 per seat.', c, recorded).removed).toHaveLength(1);
    expect(guardNarrative('On Monday Pipedrive was $9 per seat.', comp([row('Pipedrive', 'cant_verify', null)]), recorded).removed).toHaveLength(1);
  });

  it('a line is not left as a fragment after a sentence is removed', () => {
    const c = comp([row('Supabase', 'cant_verify', '$25 per month')]);
    const g = guardNarrative('- **Supabase:** The pricing page still shows $25 per month. **Supported** [S7].', c, []);
    expect(g.text).not.toContain('Supported');
  });

  it("present-tense values with citations are left alone", () => {
    const c = comp([row('Freshsales', 'not_recorded', null)]);
    expect(guardNarrative('Freshsales Growth costs $12 per seat per month today [S31].', c, []).removed).toHaveLength(0);
  });
});

describe('parseClaims section labels', () => {
  it('a bold "Earlier non-price statements" heading is not a product (live claim-check artefact)', () => {
    const claims = parseClaims("**Earlier non-price statements**:\n- HubSpot's $9 per seat price was confirmed [S1].");
    expect(claims.map((c) => c.entity)).not.toContain('Earlier non-price statements');
  });
});
