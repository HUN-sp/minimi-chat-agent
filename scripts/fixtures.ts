// Memory fixtures: known past conversations written straight into the DB, dated relative to today.
// Unlike `npm run seed` (which replays questions through the live pipeline and can fail or vary),
// these are instant, free and identical every run, so you know exactly what memory holds and can
// judge whether the agent's reply is right.
//
// Values are what the official/third-party pages stated on 11 Nov 2026. If a vendor changes a price
// later, a re-check will (correctly) report it as changed. One value is deliberately stale and
// flagged demo=1, so the "changed" path can be tested; memory and the answer label it DEMO DATA.
//
// Source excerpts are marked "[fixture snapshot]": they summarise the stored value, not a page quote.

import { getDb, insertEntitySet, insertMessage, insertSource, linkSource, upsertConversation } from '../src/memory/db.js';
import type { Tier } from '../src/search/credibility.js';
import { type CivilDate, addDays, isoDate, localTimeToUtc, prettyDate, weekday } from '../src/time/tz.js';

interface FixtureSource {
  label: string; // S1…
  url: string;
  title: string;
  tier: Tier;
  excerpt: string;
}

interface FixtureClaim {
  entity: string;
  plan: string | null;
  attribute: string;
  value: string;
  unit: string | null;
  period: string | null;
  source: string; // S-label
  demo?: boolean;
  /** Terms stated with the price (e.g. billed annually): a price is never compared across terms. */
  qualifiers?: { billing?: 'annual' | 'monthly'; region?: string };
}

export interface Fixture {
  id: string;
  /** What this case exercises. */
  purpose: string;
  day: (today: CivilDate) => CivilDate;
  time: [number, number];
  user: string;
  answer: string;
  sources?: FixtureSource[];
  claims?: FixtureClaim[];
  /** The items the turn was about (entity set). */
  items?: string[];
  /** Non-price statements the answer made (stored as fact assertions). */
  facts?: { entity: string; text: string; source?: string }[];
  failed?: boolean;
  /** Questions to ask, and what a correct reply looks like. `{date}` = this fixture's date. */
  ask: { q: string; expect: string }[];
}

/** Most recent occurrence of weekday `wd` (0 = Sunday) strictly before `today`. */
function prev(today: CivilDate, wd: number): CivilDate {
  let back = (weekday(today) - wd + 7) % 7;
  if (back === 0) back = 7;
  return addDays(today, -back);
}

const snap = (s: string) => `[fixture snapshot] ${s}`;

export const FIXTURES: Fixture[] = [
  {
    id: 'fx-crm',
    purpose: 'CRM shortlist: 4 stored prices (2 official, 2 third-party) + Freshsales listed with no price',
    day: (t) => prev(t, 1),
    time: [10, 5],
    user: "We're a 20-person sales team. Shortlist 5 CRM tools for us and give me the current per-seat monthly price of each one's main sales plan.",
    answer: `**Shortlist: 5 CRMs for a 20-person sales team** (main sales plan, per seat per month, billed annually)

| CRM | Main sales plan | Price per seat / month | Label | Source |
|---|---|---|---|---|
| HubSpot | Sales Hub Starter | $9 | **Confirmed** | [S1] |
| Salesforce | Sales Cloud Essentials | $25 | **Confirmed** | [S2] |
| Zoho CRM | Standard | $14 | **Reported** | [S3] |
| Pipedrive | Essential | $14 | **Reported** | [S4] |
| Freshsales | Growth | Can't verify | **Can't verify** | – |

For 20 seats that is about $180/month (HubSpot), $500/month (Salesforce) and $280/month (Zoho or Pipedrive).

Freshsales: its official pricing page didn't state a figure I could confirm, so I haven't quoted one.`,
    sources: [
      { label: 'S1', url: 'https://blog.hubspot.com/sales/hubspot-sales-hub-pricing', title: "HubSpot's Sales Hub pricing guide", tier: 'official', excerpt: snap('Sales Hub Starter: $9 per seat per month, billed annually.') },
      { label: 'S2', url: 'https://www.salesforce.com/small-business/pricing', title: 'Salesforce Small Business Pricing', tier: 'official', excerpt: snap('Sales Cloud Essentials: $25 per user per month.') },
      { label: 'S3', url: 'https://www.whizzbridge.com/blog/zoho-pricing', title: 'Zoho Pricing: Implementation Cost and Pricing Details [2026]', tier: 'secondary', excerpt: snap('Zoho CRM Standard: $14 per user per month, billed annually.') },
      { label: 'S4', url: 'https://www.stork.ai/blog/close-alternatives-2026', title: 'Close Alternatives (2026): Pipedrive, HubSpot, folk and More', tier: 'secondary', excerpt: snap('Pipedrive Essential: $14 per seat per month, billed annually.') },
    ],
    claims: [
      { entity: 'HubSpot', plan: 'Sales Hub Starter', attribute: 'price', value: '$9', unit: 'per seat', period: 'month', source: 'S1', qualifiers: { billing: 'annual' } },
      { entity: 'Salesforce', plan: 'Sales Cloud Essentials', attribute: 'price', value: '$25', unit: 'per seat', period: 'month', source: 'S2' },
      { entity: 'Zoho CRM', plan: 'Standard', attribute: 'price', value: '$14', unit: 'per seat', period: 'month', source: 'S3', qualifiers: { billing: 'annual' } },
      { entity: 'Pipedrive', plan: 'Essential', attribute: 'price', value: '$14', unit: 'per seat', period: 'month', source: 'S4', qualifiers: { billing: 'annual' } },
    ],
    items: ['HubSpot', 'Salesforce', 'Zoho CRM', 'Pipedrive', 'Freshsales'],
    ask: [
      {
        q: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
        expect:
          'Recalls {date}. A code-rendered table appears first: HubSpot/Salesforce checked against the vendor\'s own page (Unchanged only if plan, unit and billing terms match; otherwise "Can\'t verify"/"Not comparable" with the reason). Zoho/Pipedrive baselines are marked third-party. Freshsales: "No earlier value recorded; cannot compare." Then "Announcements since {date}": dated launches with source and publication date, or "I found no relevant announcement in the sources checked". The model adds today\'s Freshsales price and an "Interpretation:" for a 20-person team. No "nothing changed" above unverifiable rows.',
      },
    ],
  },
  {
    id: 'fx-postgres',
    purpose: 'Postgres hosting: Neon + Supabase stored, AWS RDS listed with no price; on the Tuesday BEFORE last Tuesday',
    day: (t) => addDays(prev(t, 2), -7),
    time: [14, 20],
    user: 'I need managed Postgres hosting for a small production app. What do Neon, Supabase and AWS RDS charge for their entry-level paid plans?',
    answer: `**Managed Postgres for a small production app: entry-level paid plans**

| Provider | Entry-level paid plan | Price | Label | Source |
|---|---|---|---|---|
| Neon | Launch | $0.106 per CU-hour compute · $0.35 per GB-month storage | **Confirmed** | [S1] |
| Supabase | Pro | $25 per month | **Confirmed** | [S2] |
| AWS RDS | db.t4g.micro (on-demand) | Can't verify | **Can't verify** | – |

Neon is usage-based with no monthly minimum, Supabase is a flat monthly fee per project with compute credits included, and RDS bills per instance-hour plus storage. I couldn't read a current hourly rate from the AWS page, so I haven't quoted one.`,
    sources: [
      { label: 'S1', url: 'https://neon.tech/pricing', title: 'Neon Pricing', tier: 'official', excerpt: snap('Launch: $0.106 per CU-hour compute, $0.35 per GB-month storage, no monthly minimum.') },
      { label: 'S2', url: 'https://supabase.com/pricing', title: 'Pricing & Fees | Supabase', tier: 'official', excerpt: snap('Pro: $25 per month per project.') },
    ],
    claims: [
      { entity: 'Neon', plan: 'Launch', attribute: 'compute_price', value: '$0.106', unit: 'per CU-hour', period: null, source: 'S1' },
      { entity: 'Neon', plan: 'Launch', attribute: 'storage_price', value: '$0.35', unit: 'per GB-month', period: null, source: 'S1' },
      { entity: 'Supabase', plan: 'Pro', attribute: 'price', value: '$25', unit: null, period: 'month', source: 'S2' },
    ],
    items: ['Neon', 'Supabase', 'AWS RDS'],
    facts: [
      { entity: 'Neon', text: 'Neon is usage-based with no monthly minimum', source: 'S1' },
      { entity: 'Supabase', text: 'Supabase is a flat monthly fee per project with compute credits included', source: 'S2' },
      { entity: 'AWS RDS', text: 'RDS bills per instance-hour plus storage' },
    ],
    ask: [
      {
        q: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
        expect:
          '"Last Tuesday" is ambiguous; picks {date} (the Postgres conversation), not the cold-email one, and says so. Neon/Supabase compared (Unchanged unless really changed). AWS RDS: "not recorded", today\'s price only.',
      },
      {
        q: 'What did I ask you on {day} {month}? Is your answer still correct today?',
        expect: 'Quotes the Postgres question and the earlier answer (Neon $0.106/CU-hour + $0.35/GB-month, Supabase $25/month, no AWS figure), then re-checks the prices in a code table AND lists the 3 non-price statements as not verified by code; the reply says whether today\'s sources support or contradict each.',
      },
    ],
  },
  {
    id: 'fx-email',
    purpose: 'Unrelated, no-search turn on LAST Tuesday: makes "last Tuesday" genuinely ambiguous',
    day: (t) => prev(t, 2),
    time: [11, 0],
    user: 'Write a 3-line cold email to a VP of Sales introducing our analytics tool.',
    answer: `Subject: Forecasts your team can trust

Hi {first name}, most sales teams lose a day a week reconciling pipeline numbers by hand.
Our analytics tool reads your CRM and flags at-risk deals before the forecast call.
Worth a 15-minute look next week?`,
    ask: [
      {
        q: 'What did I ask you last Tuesday?',
        expect: 'Ambiguous date: mentions both candidate Tuesdays (the cold email and the Postgres question) and asks one short question to confirm which day was meant.',
      },
    ],
  },
  {
    id: 'fx-gemini',
    purpose: 'Gemini API prices, all official; Flash input deliberately stale ($0.24, flagged DEMO DATA) to test the "changed" path',
    day: (t) => addDays(t, -6),
    time: [9, 30],
    user: "What's the Gemini API price for Gemini 2.5 Flash and Gemini 2.5 Pro, input and output per 1M tokens?",
    answer: `**Gemini API prices (paid tier, per 1M tokens)**

| Model | Input | Output | Source |
|---|---|---|---|
| Gemini 2.5 Flash | $0.24 | $2.50 | [S1] |
| Gemini 2.5 Pro | $1.25 (prompts ≤ 200k tokens) | $10.00 (prompts ≤ 200k tokens) | [S1] |

**Confirmed**: as per ai.google.dev (official pricing page) [S1].`,
    sources: [
      { label: 'S1', url: 'https://ai.google.dev/gemini-api/docs/pricing', title: 'Gemini Developer API pricing', tier: 'official', excerpt: snap('Gemini 2.5 Flash: input $0.30, output $2.50. Gemini 2.5 Pro: input $1.25, output $10.00 (prompts <= 200k tokens). Per 1M tokens.') },
    ],
    claims: [
      { entity: 'Gemini 2.5 Flash', plan: null, attribute: 'input_price', value: '$0.24', unit: 'per 1M input tokens', period: null, source: 'S1', demo: true },
      { entity: 'Gemini 2.5 Flash', plan: null, attribute: 'output_price', value: '$2.50', unit: 'per 1M output tokens', period: null, source: 'S1' },
      { entity: 'Gemini 2.5 Pro', plan: null, attribute: 'input_price_le_200k_tokens', value: '$1.25', unit: 'per 1M input tokens', period: null, source: 'S1' },
      { entity: 'Gemini 2.5 Pro', plan: null, attribute: 'output_price_le_200k_tokens', value: '$10.00', unit: 'per 1M output tokens', period: null, source: 'S1' },
    ],
    items: ['Gemini 2.5 Flash', 'Gemini 2.5 Pro'],
    ask: [
      {
        q: "I asked about Gemini's API price on {day} {month}. Did it change?",
        expect: 'Flash input: "Differs from our earlier answer" $0.24 → $0.30 (not a vendor change: the stored source never said $0.24), flagged DEMO DATA. The other three: Unchanged, from ai.google.dev.',
      },
    ],
  },
  {
    id: 'fx-failed',
    purpose: 'A turn whose answer FAILED (rate limit): question + items remembered, no answer',
    day: (t) => prev(t, 0),
    time: [16, 45],
    user: 'Compare the Pro plan prices of Vercel, Netlify and Cloudflare Pages for a small team.',
    answer: "Sorry, I couldn't produce an answer this time. Please try again.",
    failed: true,
    items: ['Vercel', 'Netlify', 'Cloudflare Pages'],
    ask: [
      {
        q: 'On Sunday I asked about hosting platforms. Has their pricing changed since?',
        expect: 'Says no answer was given on {date}, so there are no earlier values; gives today\'s Vercel / Netlify / Cloudflare Pages prices with NO "Then" values and no "unchanged" claim.',
      },
    ],
  },
];

export interface LoadedFixture {
  id: string;
  date: CivilDate;
  purpose: string;
  claims: number;
  ask: { q: string; expect: string }[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Write all fixtures (replacing earlier copies). Dates are relative to `today` in `tz`. */
export function loadFixtures(today: CivilDate, tz: string): LoadedFixture[] {
  const db = getDb();
  const out: LoadedFixture[] = [];
  for (const f of FIXTURES) {
    // Replace any earlier copy, including its source rows.
    const old = db.prepare('SELECT ms.source_id FROM message_sources ms JOIN messages m ON m.id = ms.message_id WHERE m.conversation_id = ?').all(f.id) as { source_id: number }[];
    db.prepare('DELETE FROM fts_messages WHERE rowid IN (SELECT id FROM messages WHERE conversation_id = ?)').run(f.id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(f.id);
    for (const { source_id } of old) db.prepare('DELETE FROM sources WHERE id = ?').run(source_id);

    const date = f.day(today);
    const at = localTimeToUtc(date, f.time[0], f.time[1], tz);
    const atIso = at.toISOString();
    const local = isoDate(date);
    upsertConversation(f.id, f.user.replace(/\s+/g, ' ').slice(0, 70), atIso, tz);
    insertMessage({ conversation_id: f.id, role: 'user', content: f.user, created_at: atIso, local_date: local, user_tz: tz, meta_json: null });
    const answerId = insertMessage({
      conversation_id: f.id,
      role: 'assistant',
      content: f.answer,
      created_at: new Date(at.getTime() + 6_000).toISOString(),
      local_date: local,
      user_tz: tz,
      meta_json: JSON.stringify({ fixture: f.id }),
      failed: !!f.failed,
    });

    const sourceIds = new Map<string, number>();
    for (const s of f.sources ?? []) {
      const domain = new URL(s.url).hostname.replace(/^www\./, '');
      const id = insertSource({ url: s.url, canonical_url: s.url.replace('://www.', '://'), domain, title: s.title, published_at: null, retrieved_at: atIso, content_hash: 'fixture', excerpt: s.excerpt, tier: s.tier });
      sourceIds.set(s.label, id);
      linkSource(answerId, id, s.label, true);
    }
    const insClaim = db.prepare(
      `INSERT INTO claims (message_id, entity, attribute, value, unit, period, plan, as_of, source_id, confidence, demo, kind, status, qualifiers_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of f.claims ?? [])
      insClaim.run(answerId, c.entity, c.attribute, c.value, c.unit, c.period, c.plan, local, sourceIds.get(c.source) ?? null, 0.95, c.demo ? 1 : 0, 'price', 'supported', c.qualifiers ? JSON.stringify(c.qualifiers) : null);
    for (const x of f.facts ?? [])
      insClaim.run(answerId, x.entity, 'statement', x.text, null, null, null, local, x.source ? (sourceIds.get(x.source) ?? null) : null, 0.6, 0, 'fact', x.source ? 'cited' : 'uncited', null);
    if (f.items && f.items.length >= 2) insertEntitySet(answerId, f.user.replace(/\s+/g, ' ').slice(0, 100), f.items);

    const fill = (s: string) => s.replace(/\{date\}/g, prettyDate(date)).replace(/\{day\}/g, String(date.d)).replace(/\{month\}/g, MONTHS[date.m - 1]);
    out.push({ id: f.id, date, purpose: f.purpose, claims: f.claims?.length ?? 0, ask: f.ask.map((a) => ({ q: fill(a.q), expect: fill(a.expect) })) });
  }
  return out;
}
