// Source credibility tiers. "Official" means "this publisher IS the vendor of this entity", and
// every official decision records its justification. Things that are only hints never decide it:
//   • a domain the model passed to web_search (a search hint, not proof of ownership);
//   • a URL that happens to be stored in memory (being stored never promotes a source);
//   • a domain that merely CONTAINS the vendor's name (salesforceben.com is not Salesforce).
// A publisher relationship is established only by:
//   1. the registrable domain's name being exactly the vendor's brand (hubspot.com → HubSpot), or
//   2. a small explicit parent-company table with a written reason (Gemini → Google's domains).
// Anything uncertain stays secondary: misclassifying as secondary only makes the answer more
// cautious, never wrong. This is deliberately not an exhaustive vendor directory.

export type Tier = 'official' | 'reputable' | 'secondary';

export interface TierDecision {
  tier: Tier;
  reason: string;
  /** Entities (from the ones in play) this source is the official publisher for. */
  publisherFor: string[];
}

const REPUTABLE = new Set([
  'reuters.com', 'bloomberg.com', 'apnews.com', 'ft.com', 'wsj.com', 'nytimes.com', 'cnbc.com', 'bbc.com', 'bbc.co.uk',
  'techcrunch.com', 'theverge.com', 'arstechnica.com', 'wired.com', 'theinformation.com', 'venturebeat.com', 'zdnet.com',
  'theregister.com', 'axios.com', 'infoq.com', 'engadget.com', 'github.com',
]);

const AGGREGATORS = new Set([
  'costgoat.com', 'g2.com', 'capterra.com', 'getapp.com', 'softwareadvice.com', 'trustradius.com', 'saasworthy.com',
  'medium.com', 'quora.com', 'reddit.com', 'linkedin.com', 'youtube.com', 'pricepertoken.com', 'artificialanalysis.ai',
  'saasprices.net', 'vendr.com', 'tekpon.com', 'crozdesk.com', 'sourceforge.net', 'slashdot.org', 'producthunt.com',
]);

/**
 * Parent-company relationships that a brand-equals-domain rule cannot see. Each entry states why.
 * An entity matched here is official ONLY on these domains (gemini.com is a crypto exchange).
 */
const PUBLISHERS: { entity: RegExp; domains: string[]; why: string }[] = [
  { entity: /\b(gemini|google|vertex|bard)\b/i, domains: ['google.dev', 'google.com', 'googleblog.com', 'blog.google'], why: 'Gemini/Vertex are Google products' },
  { entity: /\b(aws|amazon|rds|aurora|lambda|bedrock)\b/i, domains: ['amazon.com', 'aboutamazon.com'], why: 'AWS services are published on amazon.com (aws.amazon.com)' },
  { entity: /\b(azure|microsoft|copilot|dynamics)\b/i, domains: ['microsoft.com', 'azure.com'], why: 'Azure/Copilot/Dynamics are Microsoft products' },
  { entity: /\b(openai|chatgpt|gpt-?\d[\w.-]*|o\d(-mini)?)\b/i, domains: ['openai.com'], why: 'ChatGPT/GPT models are OpenAI products' },
  { entity: /\b(claude|anthropic)\b/i, domains: ['anthropic.com', 'claude.com'], why: 'Claude is an Anthropic product' },
  { entity: /\b(llama|meta)\b/i, domains: ['meta.com', 'llama.com', 'facebook.com'], why: 'Llama is a Meta product' },
];

const GENERIC_WORDS = new Set([
  'api', 'apis', 'pricing', 'price', 'prices', 'plan', 'plans', 'cost', 'costs', 'crm', 'cloud', 'hosting', 'database',
  'news', 'latest', 'update', 'updates', 'change', 'changes', 'changed', 'new', 'the', 'and', 'for', 'tool', 'tools', 'free',
  'pro', 'plus', 'team', 'teams', 'business', 'enterprise', 'starter', 'model', 'models', 'per', 'month', 'monthly', 'year',
  'official', 'page', 'docs', 'release', 'notes', 'announcement', 'postgres', 'postgresql', 'sales', 'small', 'best', 'vs',
  // plan / tier words: "Pro Suite" must not make larksuite.com official
  'suite', 'growth', 'professional', 'advanced', 'essential', 'standard', 'premium', 'ultimate', 'basic', 'launch', 'scale',
  'formerly', 'edition', 'hub', 'tier', 'usage', 'based', 'paid', 'entry', 'level', 'flash', 'lite', 'input', 'output',
  'changelog', 'feature', 'features', 'shipped', 'launches', 'launched', 'product',
]);

const MULTI_PART_TLDS = new Set(['co.uk', 'com.au', 'co.in', 'co.jp', 'com.br', 'co.nz', 'org.uk', 'ac.uk', 'gov.uk']);
const COMPARISON_PATH = /(^|\/|-)(compare|comparison|vs|versus|alternatives?|competitors?)(\/|-|$|\.)/i;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Approximate registrable domain: "ai.google.dev" → "google.dev", "bbc.co.uk" → "bbc.co.uk". */
export function registrableDomain(host: string): string {
  const parts = host.split('.');
  const last2 = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(last2) && parts.length >= 3) return parts.slice(-3).join('.');
  return last2;
}

/** "Zoho CRM" → ["zoho"], "Google Gemini" → ["google", "gemini"], "HubSpot" → ["hubspot"]. */
export function entityTokens(name: string): string[] {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
  return [...new Set(words)];
}

/** Capitalised words in a query ("Gemini API pricing" → ["Gemini"]) as weak entity hints. */
export function entitiesFromQuery(q: string): string[] {
  return (q.match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? []).filter((w) => !GENERIC_WORDS.has(w.toLowerCase()));
}

/** The brand an entity name starts with: "Zoho CRM" → "zoho", "monday.com CRM" → "monday", "AWS RDS" → "aws". */
function brandOf(entity: string): string | null {
  const first = entity
    .toLowerCase()
    .replace(/\.(com|io|ai|dev|tech|app|co)\b/g, '')
    .split(/[^a-z0-9]+/)
    .find((w) => w.length >= 2 && !GENERIC_WORDS.has(w));
  return first ?? null;
}

/**
 * Is the site at `url` the official publisher for `entity`? Returns the justification, or null.
 * This is the single place that decides vendor ownership.
 */
export function publisherRelation(url: string, entity: string): string | null {
  const host = hostOf(url);
  if (!host || !entity.trim()) return null;
  const reg = registrableDomain(host);
  if (AGGREGATORS.has(reg) || REPUTABLE.has(reg) || USER_CONTENT_HOST.test(host)) return null;
  const known = PUBLISHERS.find((p) => p.entity.test(entity));
  if (known) {
    const d = known.domains.find((x) => reg === x || host === x || host.endsWith('.' + x));
    return d ? `${known.why} (${d})` : null;
  }
  const brand = brandOf(entity);
  const label = reg.split('.')[0];
  if (brand && brand.length >= 3 && label === brand) return `the domain ${reg} is the ${entity} brand name`;
  // Concatenated brand: "Cloudflare Pages" → cloudflare.com handled above; "Close CRM" → close.com.
  const compact = entityTokens(entity).join('');
  if (compact.length >= 4 && label === compact) return `the domain ${reg} is the ${entity} brand name`;
  return null;
}

export interface TierContext {
  entities?: string[]; // entity names in play (memory claims + query hints)
  /** Vendor domains the model passed to web_search. A search hint only: never makes a source official. */
  domains?: string[];
}

/** Titles like "Neon Launch vs Supabase Pro: Pricing and Features" or "Best Pipedrive alternatives". */
const COMPARISON_TITLE = /\b(vs\.?|versus|compared? (to|with)|comparison|alternatives?|competitors?)\b/i;

export function decideTier(url: string, ctx: TierContext = {}, title = ''): TierDecision {
  const host = hostOf(url);
  if (!host) return { tier: 'secondary', reason: 'no host', publisherFor: [] };
  const reg = registrableDomain(host);
  if (AGGREGATORS.has(reg)) return { tier: 'secondary', reason: `${reg} is an aggregator/forum`, publisherFor: [] };
  if (REPUTABLE.has(reg)) return { tier: 'reputable', reason: `${reg} is an established news/tech outlet`, publisherFor: [] };

  let path = '';
  let query = '';
  try {
    const u = new URL(url);
    path = u.pathname.toLowerCase();
    // Some sites route every page through one path and put the slug in the query:
    // neon.tech/unify?n=guides%2Fneon-launch-plan-vs-supabase-pro-plan
    query = decodeURIComponent(u.search).toLowerCase();
  } catch {}
  // A vendor's "us vs them" page is about a competitor's prices: never authoritative.
  if (COMPARISON_PATH.test(path) || COMPARISON_PATH.test(query.replace(/[?&=]/g, '/')) || COMPARISON_TITLE.test(title))
    return { tier: 'secondary', reason: 'comparison/alternatives page', publisherFor: [] };

  // A vendor's forum is its users talking, not the vendor (community.openai.com, community.hubspot.com).
  if (USER_CONTENT_HOST.test(host)) return { tier: 'secondary', reason: `${host} is a user forum/community site`, publisherFor: [] };

  const publisherFor: string[] = [];
  const reasons: string[] = [];
  for (const e of new Set(ctx.entities ?? [])) {
    const why = publisherRelation(url, e);
    if (why) {
      publisherFor.push(e);
      reasons.push(why);
    }
  }
  if (publisherFor.length) return { tier: 'official', reason: reasons[0], publisherFor };
  // Primary sources that don't depend on which products are "in play": a known vendor's own site
  // speaking about its own work, and government / university sites speaking for themselves.
  // Live regression: in "latest on AI safety research" (no product named) anthropic.com and
  // openai.com were tiered "secondary" while hubspot.com was "official" in the CRM answer.
  // (User-generated hosts like facebook.com don't speak for the vendor.)
  const vendor = PUBLISHERS.find((p) => p.domains.some((x) => x !== 'facebook.com' && (reg === x || host === x || host.endsWith('.' + x))));
  if (vendor) return { tier: 'official', reason: `${reg} is the vendor's own site (${vendor.why}); primary source for its own announcements`, publisherFor: [] };
  if (INSTITUTIONAL.test(host)) return { tier: 'official', reason: `${reg} is a government or university site (primary source for its own announcements)`, publisherFor: [] };
  return { tier: 'secondary', reason: 'no established publisher relationship', publisherFor: [] };
}

const USER_CONTENT_HOST = /^(community|forum|forums|discuss|discourse|answers|users|ideas|feedback|stackoverflow)\./;

/** Government and university hosts: "*.gov", "gov.uk", "gouv.fr", "europa.eu", "*.edu", "ac.uk", "nic.in"… */
const INSTITUTIONAL = /(^|\.)(gov|gouv|gob|govt|europa|edu|mil)(\.[a-z]{2,3})?$|(^|\.)(gov|gouv|gob|ac|edu)\.[a-z]{2}$|(^|\.)gc\.ca$|(^|\.)nic\.in$/;

/** Back-compat helper: just the tier. */
export function tierFor(url: string, _canonicalUrl: string, ctx: TierContext = {}, title = ''): Tier {
  return decideTier(url, ctx, title).tier;
}

export function tierLabel(t: Tier): 'Confirmed' | 'Reported' {
  return t === 'official' ? 'Confirmed' : 'Reported';
}
