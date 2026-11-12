// Regressions from the 2026-11-12 manual test pass (issues #1–#13). Each test reproduces what the
// live run did wrong, with the real page text where it mattered.

import { describe, expect, it } from 'vitest';
import { resolveClarification } from '../src/agent/clarify.js';
import { route } from '../src/agent/router.js';
import { inconsistencies } from '../src/answer/consistency.js';
import { stalePrices } from '../src/answer/freshness.js';
import { checkCitedValues, checkGrounding } from '../src/answer/grounding.js';
import { enforceLabels } from '../src/answer/labels.js';
import { guardNarrative } from '../src/answer/narrative.js';
import { eventMention, extractObservations } from '../src/evidence/observations.js';
import { checkAnswerClaims } from '../src/memory/assertions.js';
import type { ClaimRow, MessageRow } from '../src/memory/db.js';
import { decideTier } from '../src/search/credibility.js';
import type { Evidence } from '../src/search/postprocess.js';
import { lookupCurrent } from '../src/verify/reverify.js';

const NOW = new Date('2026-11-12T06:00:00Z'); // Thursday
const TODAY = '2026-11-12';

function ev(id: string, url: string, title: string, excerpt: string, publishedAt: string | null = null, tier: Evidence['tier'] = 'official'): Evidence {
  return { id, url, canonicalUrl: url, domain: new URL(url).hostname.replace(/^www\./, ''), title, excerpt, sections: [excerpt], publishedAt, retrievedAt: `${TODAY}T06:00:00Z`, tier, kind: 'general', query: '', contentHash: id };
}

function claim(p: Partial<ClaimRow>): ClaimRow {
  return { id: 1, message_id: 1, entity: 'X', attribute: 'price', value: '$1', unit: null, period: null, plan: null, as_of: '2026-11-03', source_id: 1, confidence: 0.95, demo: 0, kind: 'price', status: 'supported', ...p };
}

describe('#1 a short reply to our clarifying question is resolved against the pending question', () => {
  const windows = [
    { phrase: 'last Tuesday', label: 'Tue 10 Nov 2026', from: '2026-11-10', to: '2026-11-10', group: 0 },
    { phrase: 'last Tuesday', label: 'Tue 3 Nov 2026', from: '2026-11-03', to: '2026-11-03', group: 0 },
  ];
  const history: MessageRow[] = [
    { id: 17, conversation_id: 'c', role: 'user', content: 'What did I ask you last Tuesday?', created_at: '', local_date: TODAY, user_tz: 'UTC', meta_json: null, failed: 0 },
    {
      id: 18,
      conversation_id: 'c',
      role: 'assistant',
      content: 'On Tue 10 Nov 2026 you asked for a cold email.\n\nOn Tue 3 Nov 2026 you asked about Postgres hosting.\n\nWhich of those dates is the "last Tuesday" you mean?',
      created_at: '',
      local_date: TODAY,
      user_tz: 'UTC',
      meta_json: JSON.stringify({ windows, memory: { ambiguous: { phrase: 'last Tuesday', options: ['Tue 10 Nov 2026', 'Tue 3 Nov 2026'] } } }),
      failed: 0,
    },
  ];

  it('"3 Nov" becomes "What did I ask you on Tue 3 Nov 2026?", routed as pure recall', () => {
    const c = resolveClarification('3 Nov', history, NOW, 'UTC');
    expect(c).toMatchObject({ label: 'Tue 3 Nov 2026', effective: 'What did I ask you on Tue 3 Nov 2026?' });
    expect(route(c!.effective, true)).toMatchObject({ memoryIntent: true, pureRecall: true, changeIntent: false });
  });

  it('understands "the 10th", "the first one", "the earlier one"', () => {
    expect(resolveClarification('the 10th', history, NOW, 'UTC')?.label).toBe('Tue 10 Nov 2026');
    expect(resolveClarification('the first one', history, NOW, 'UTC')?.label).toBe('Tue 10 Nov 2026');
    expect(resolveClarification('the earlier one', history, NOW, 'UTC')?.label).toBe('Tue 3 Nov 2026');
  });

  it('does nothing without a pending question, or for a real new question', () => {
    expect(resolveClarification('3 Nov', history.slice(0, 1), NOW, 'UTC')).toBeNull();
    expect(resolveClarification('What is the latest Postgres release and what changed in it since version 17?', history, NOW, 'UTC')).toBeNull();
  });

  it('the guard removes earlier values that were never recorded, even in a table under a product heading', () => {
    // The answer the live model wrote for "3 Nov" (abridged). Recorded on 3 Nov: Neon Launch compute
    // $0.106 and storage $0.35, Supabase Pro $25. Nothing for AWS RDS.
    const text = [
      '**Neon (Launch plan)**',
      '| Item | Live price | Source | Status vs 3 Nov 2026 |',
      '|---|---|---|---|',
      '| Compute (CU-hour) | $0.222 / CU-hour | [S5] | **Increased** from $0.106 (3 Nov) |',
      '| Storage (GB-month) | $0.35 / GB-month | [S6] | **Increased** from $0.25 (3 Nov) |',
      '',
      '**Supabase (Pro plan)**',
      '| Item | Live price | Source | Status vs 3 Nov 2026 |',
      '|---|---|---|---|',
      '| Base plan | $25 / month | [S10] | **Same** as $25 (3 Nov) |',
      '| Additional projects | $10 / month each | [S10] | **Same** as $10 (3 Nov) |',
      '',
      '**AWS RDS (db.t4g.micro)**',
      '| Item | Live price | Source | Status vs 3 Nov 2026 |',
      '|---|---|---|---|',
      '| Hourly rate | $0.0160 / hr | [S15] | **Same** as $0.016 (3 Nov) |',
      '',
      '- Supabase and AWS RDS prices remain unchanged from the 3 Nov snapshot.',
    ].join('\n');
    const recorded = [
      claim({ id: 5, entity: 'Neon', plan: 'Launch', attribute: 'compute_price', value: '$0.106', unit: 'per CU-hour' }),
      claim({ id: 6, entity: 'Neon', plan: 'Launch', attribute: 'storage_price', value: '$0.35', unit: 'per GB-month' }),
      claim({ id: 7, entity: 'Supabase', plan: 'Pro', value: '$25', period: 'month' }),
    ];
    const g = guardNarrative(text, null, recorded, { market: { evidence: [], anchor: '2026-11-03', today: TODAY } });
    expect(g.text).toContain('Increased** from $0.106'); // recorded for Neon: kept
    expect(g.text).toContain('Same** as $25'); // recorded for Supabase: kept
    expect(g.text).not.toContain('from $0.25'); // never recorded (we said $0.35)
    expect(g.text).not.toContain('as $10');
    expect(g.text).not.toContain('as $0.016'); // AWS RDS had no earlier value
    expect(g.text).not.toContain('remain unchanged');
    expect(g.removed).toHaveLength(4);
  });
});

describe('guard does not mistake "then" (= after that) for an earlier value', () => {
  it('keeps "$50 / month for 5 users, then $10 / user extra"', () => {
    const row = '| HubSpot CRM | Starter – $50 / month for up to 5 users, then $10 / user extra [S3] |';
    const text = `| CRM | Paid tier |\n|---|---|\n${row}`;
    const g = guardNarrative(text, null, [claim({ entity: 'Zoho CRM', value: '$14' })], { market: { evidence: [], anchor: TODAY, today: TODAY } });
    expect(g.text).toContain(row);
    expect(g.removed).toHaveLength(0);
  });
});

describe('blanket verdicts with a qualifier are still blanket verdicts', () => {
  it('removes "No further pricing changes detected …" when rows could not be verified (live text)', () => {
    const comp = { anchor: '2026-11-09', checked: TODAY, rows: [{ entity: 'HubSpot', status: 'cant_verify' }], events: [], undatedEvents: 0, facts: [], coverage: {}, launches: true, entities: ['HubSpot'] } as any;
    const g = guardNarrative('No further pricing changes detected for HubSpot, Salesforce, Zoho, or Pipedrive.', comp, []);
    expect(g.removed).toHaveLength(1);
  });
});

describe('#2 a repeated question can not silently change its numbers', () => {
  it('finds the price that differs from the earlier answer (same product, plan and attribute)', () => {
    const earlier = [claim({ entity: 'HubSpot CRM', plan: 'Starter', value: '$7', unit: 'per user', period: 'month', status: 'unsupported' }), claim({ id: 2, entity: 'Freshsales', plan: 'Growth', value: '$9', unit: 'per user', period: 'month' })];
    const now = ['| CRM | Plan | Price | Source |', '|---|---|---|---|', '| HubSpot CRM | Starter | $45 / user / month | [S1] |', '| Freshsales | Growth | $9 / user / month | [S14] |'].join('\n');
    const d = inconsistencies(now, earlier);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ entity: 'HubSpot CRM', then: '$7 per user per month' });
    expect(d[0].now).toContain('$45');
  });
});

describe('#3 add-on and credit amounts are not the plan price', () => {
  it('Supabase Pro: "Additional projects from $10/mo" under "### Pro" is an add-on price (live page text)', () => {
    const page = ev(
      'S7',
      'https://supabase.com/pricing',
      'Pricing & Fees | Supabase',
      '### Pro\nMost Popular\nFor production applications with the power to scale.\nGet Started\n/ month\nFirst project included. Additional projects from $10/mo.See how pricing scales\nEverything in the Free Plan, plus:\n* 8 GB disk size per project\n then $0.125 per GB',
    );
    const obs = extractObservations(page, ['Supabase'], NOW).filter((o) => o.kind === 'price');
    expect(obs.find((o) => o.value === '$10')?.attribute).toBe('addon_price');
    expect(obs.some((o) => o.attribute === 'price' && o.value === '$10')).toBe(false);
    // …so the stored "$25 per month" for Pro finds no current value instead of "changed to $10".
    const c = claim({ entity: 'Supabase', plan: 'Pro', value: '$25', period: 'month' });
    expect(lookupCurrent(c, [{ ...page, observations: extractObservations(page, ['Supabase'], NOW) }], '2026-11-03', TODAY).kind).toBe('none');
  });

  it('"includes $10 in compute credits" is not a price at all', () => {
    const page = ev('S1', 'https://supabase.com/pricing', 'Supabase pricing', 'The Supabase Pro plan is $25 per month and includes $10 in compute credits.');
    const obs = extractObservations(page, ['Supabase'], NOW).filter((o) => o.kind === 'price');
    expect(obs.map((o) => o.value)).toEqual(['$25']);
  });
});

describe('#4/#5 old pages never stand for today\'s price', () => {
  it('a re-check never shows a page published before the anchor as "Now", whichever plan branch applies', () => {
    const blog = ev('S1', 'https://neon.tech/blog/new-usage-based-pricing', "Neon's New Pricing, Explained", 'Launch is an ideal paid plan for growing projects. Pay-as-you-go compute at $0.14 per CU-hour.', '2025-08-14');
    const c = claim({ entity: 'Neon', plan: 'Launch', attribute: 'compute_price', value: '$0.106', unit: 'per CU-hour' });
    const l = lookupCurrent(c, [{ ...blog, observations: extractObservations(blog, ['Neon'], NOW) }], '2026-11-03', TODAY);
    expect(l.kind).toBe('stale');
  });

  it('a current price citing only a 2018 vendor page is flagged and not labelled Confirmed', () => {
    const old = ev('S3', 'https://www.hubspot.com/pricing/crm', 'HubSpot CRM pricing', 'Starter: $7 per user per month.', '2018-07-16');
    const lab = enforceLabels('| HubSpot CRM | Starter | $7 / user | [S3] Confirmed |', [old], TODAY);
    expect(lab.text).not.toMatch(/\bConfirmed\b/);
    expect(lab.text).toContain("Can't verify");
    const stale = stalePrices([{ entity: 'HubSpot CRM', plan: 'Starter', value: '$7', sources: ['S3'], approximate: false }], [old], TODAY);
    expect(stale).toHaveLength(1);
  });

  it('a price cited to a page that lists it under ANOTHER plan is not supported (Scale $0.222 shown as Launch)', () => {
    const page = ev('S5', 'https://neon.com/pricing', 'Neon pricing', '### Launch\nCompute: $0.106 per CU-hour\n### Scale\nCompute: $0.222 per CU-hour');
    page.observations = [
      { id: 'S5#1', sourceId: 'S5', kind: 'price', entity: 'Neon', plan: 'Launch', attribute: 'compute_price', value: '$0.106', unit: 'per CU-hour', period: null, qualifiers: {}, span: '', publishedAt: null, observedAt: '', effectiveDate: null, eventDate: null },
      { id: 'S5#2', sourceId: 'S5', kind: 'price', entity: 'Neon', plan: 'Scale', attribute: 'compute_price', value: '$0.222', unit: 'per CU-hour', period: null, qualifiers: {}, span: '', publishedAt: null, observedAt: '', effectiveDate: null, eventDate: null },
    ];
    const checks = checkAnswerClaims('| Product | Plan | Compute |\n|---|---|---|\n| Neon | Launch | $0.222 per CU-hour [S5] |', [page]);
    expect(checks[0]).toMatchObject({ supported: false });
    expect(checks[0].reason).toContain('Scale');
  });
});

describe('#6/#7 announcements are about the product, not a namesake or a tutorial', () => {
  it('rejects "Neon Polygons" (a game studio) for Neon the database', () => {
    expect(eventMention('Neon', 'Back when we announced the Steam launch date, the Piece by Piece from Neon Polygons also announced their launch date.')).toBe(false);
    expect(eventMention('Neon', 'Neon launches database branching for every plan.')).toBe(true);
    expect(eventMention('Neon', 'Neon Launches Instant Restore For Postgres')).toBe(true); // Title Case headline
  });

  it('"AWS" alone is not "AWS RDS"; tutorials and negated announcements are not announcements', () => {
    expect(eventMention('AWS RDS', 'The walkthrough deploys one account, then rolls out to organizations with AWS CloudFormation StackSets.')).toBe(false);
    const tutorial = ev('S17', 'https://aws.amazon.com/blogs/database/x', 'Build an organization-wide Amazon RDS posture dashboard with Kiro | AWS Database Blog', 'AWS announced that Amazon RDS now rolls out deletion protection reports.', '2026-11-03');
    expect(extractObservations(tutorial, ['AWS RDS'], NOW).filter((o) => o.kind === 'event')).toHaveLength(0);
    const negated = ev('S16', 'https://shattered.io/aurora-vs-rds', 'Aurora vs RDS', 'The research for this piece found no announced retirement of RDS, and AWS continues to update RDS pricing.', '2026-11-06', 'secondary');
    expect(extractObservations(negated, ['AWS RDS'], NOW).filter((o) => o.kind === 'event')).toHaveLength(0);
  });
});

describe('#8/#11 cited statements must be in the cited source', () => {
  const ai100 = ev(
    'S10',
    'https://ai100.stanford.edu/2026-report',
    'AI100 2026 report',
    'Work at Anthropic has shown that it is possible to decompose the representations of LLMs into interpretable features. Scaling this approach to Claude 3 Sonnet demonstrated that human evaluators judged approximately 70% of features interpretable.',
  );
  it('flags a row whose names are not in its source (live answer text)', () => {
    const answer = [
      '| Work | Key contribution | Source |',
      '|---|---|---|',
      '| Anthropic “Circuit-Level Decomposition” (2025-2026) | Shows how to isolate and edit specific “feature-circuits” in Claude-2 | Stanford AI100 report [S10] |',
    ].join('\n');
    const u = checkGrounding(answer, [ai100], 'Anything on mechanistic interpretability?');
    expect(u).toHaveLength(1);
    expect(u[0].missing).toEqual(expect.arrayContaining(['Claude-2']));
  });
  it('a price in any format must be in a cited source; a recorded earlier value in a Then position is exempt', () => {
    const supa = ev('S7', 'https://supabase.com/pricing', 'Pricing & Fees | Supabase', '### Pro\n/ month\nFirst project included. Additional projects from $10/mo.');
    const live = "- **Supabase flat-fee claim** – Supabase's pricing page lists the Pro plan at $25 per month, confirming the flat-fee description [S7].";
    expect(checkCitedValues(live, [supa], ['$25'])).toMatchObject([{ values: ['$25'] }]);
    expect(checkCitedValues('- Supabase Pro was $25 on 3 Nov; additional projects are from $10/mo [S7].', [supa], ['$25'])).toHaveLength(0);
  });
  it('flags a plain-prose row whose wording is mostly not in its source (live answer text)', () => {
    const tr = ev(
      'S14',
      'https://www.technologyreview.com/2026/10/19/interp',
      'A new interpretability claim, and the skeptics',
      'Neel Nanda at Google DeepMind, who helped pioneer mechanistic interpretability alongside Cammarata, is also skeptical. "This is interesting work, but I don\'t think it\'s a significant update to the big picture of interpretability," he wrote on X.',
      '2026-10-19',
      'secondary',
    );
    const row =
      "| **DeepMind internal report (public summary)** | Summarizes DeepMind's progress on microscope tools that map feature emergence across training steps, and introduces a formalism for verifying that a discovered circuit implements a provable logical rule. | Bridges mechanistic insights with formal verification. | [S14] |";
    const u = checkGrounding(`| Work | Contribution | Relevance | Source |\n|---|---|---|---|\n${row}`, [tr]);
    expect(u).toHaveLength(1);
    expect(u[0].coverage).toBeLessThan(30);
    // …but an honest absence statement is not flagged.
    expect(checkGrounding("- AWS RDS entry-level price: no current official AWS page lists a specific on-demand price for the db.t4g.micro instance in the sources checked, so I couldn't verify it [S14].", [tr])).toHaveLength(0);
  });
  it('does not flag a faithful row', () => {
    const answer = 'Anthropic showed LLM representations can be decomposed into interpretable features; scaled to Claude 3 Sonnet, evaluators judged about 70% of features interpretable [S10].';
    expect(checkGrounding(answer, [ai100])).toHaveLength(0);
  });
});

describe('#9 publisher tiers are consistent', () => {
  it('a vendor or government site is a primary source even when no product is "in play"', () => {
    expect(decideTier('https://www.anthropic.com/news/threat-intelligence-report', {}, 'Threat Intelligence Report \\ Anthropic').tier).toBe('official');
    expect(decideTier('https://openai.com/index/nask-partnership', {}, 'OpenAI and NASK').tier).toBe('official');
    expect(decideTier('https://uk.diplomatie.gouv.fr/en/paris-call', {}, 'Paris Call').tier).toBe('official');
    expect(decideTier('https://news.cornell.edu/stories/2026/11/ai-safety-center', {}, 'New AI safety center | Cornell Chronicle').tier).toBe('official');
    expect(decideTier('https://www.politico.com/news/2026/11/10/ny-ai-testing', {}, 'NY launches AI testing - POLITICO').tier).toBe('secondary');
    expect(decideTier('https://www.facebook.com/someone/posts/1', {}, 'post').tier).toBe('secondary');
    expect(decideTier('https://community.openai.com/t/latent-geometry/123', { entities: ['OpenAI'] }, 'Could latent geometry guide reasoning?').tier).toBe('secondary');
  });
});

describe('#10 labels: our own conversions are not "Confirmed"', () => {
  it('marks the ≈ conversion as ours', () => {
    const zoho = ev('S7', 'https://www.zoho.com/bigin/pricing.html', 'Bigin pricing', 'Express: ₹1,400 per user per month, billed annually.');
    const out = enforceLabels('| Zoho Bigin | Express | ₹1,400 ≈ $16 / user / month | [S7] Confirmed |', [zoho], TODAY).text;
    expect(out).toContain('Confirmed (the ≈ figure is our conversion/estimate');
  });
});

describe('#12 a bare topic plus a date is a memory question', () => {
  it('"Postgres last Tuesday?" consults memory; "news last Tuesday?" does not', () => {
    expect(route('Postgres last Tuesday?', true).memoryIntent).toBe(true);
    expect(route('news last Tuesday?', true).memoryIntent).toBe(false);
    expect(route('What is the latest Postgres release?', false).memoryIntent).toBe(false);
  });
});
