// Deterministic old-vs-new comparison. Normalises currency, billing period and unit basis so
// "$19/mo" and "19 USD per month" compare equal, and "$300/yr" equals "$25/mo".
// An LLM asked "did it change?" reports phrasing differences as changes; code doesn't.
//
// Comparability is strict: a currency, unit, billing period or billing/region qualifier stated on
// only ONE side is unknown, not compatible, so the result is "can't verify", never "unchanged".
// Equality is precision-aware: $0.001 → $0.002 per request is a change (no global tolerance).

export type DiffStatus = 'changed' | 'unchanged' | 'cant_verify';

export interface Money {
  amount: number; // per month when period is month/year, else as stated
  currency: string; // USD | EUR | GBP | INR | … | UNKNOWN (no symbol or code was written)
  period: 'month' | 'hour' | 'one_time' | 'none';
  basis: string | null; // seat | 1m_tokens | gb | cu_hour | request | null
  free: boolean;
  stated: number; // the number as written, before any /yr → /mo conversion
  decimals: number; // decimal places as written ("$0.30" → 2)
  converted: boolean; // a yearly price converted to per-month
}

/** Terms that change what a price means. Unknown = not stated (never assumed compatible). */
export interface Qualifiers {
  billing?: 'annual' | 'monthly';
  region?: string;
}

const CURRENCY_SYMBOLS: [RegExp, string][] = [
  [/US\$|\$|\busd\b|\bdollars?\b/i, 'USD'],
  [/€|\beur\b|\beuros?\b/i, 'EUR'],
  [/£|\bgbp\b|\bpounds?\b/i, 'GBP'],
  [/₹|\binr\b|\brs\.?\b|\brupees?\b/i, 'INR'],
  [/¥|\bjpy\b|\byen\b/i, 'JPY'],
];

function detectBasis(s: string): string | null {
  if (/\b(1m|1 ?million|million|mtok|m tokens|per m\b)/i.test(s) || /\/\s*m\s*(input|output)?\s*tokens?/i.test(s)) return '1m_tokens';
  if (/\b(1k|thousand) tokens?\b/i.test(s)) return '1k_tokens';
  if (/\b(seat|user|member|agent|editor|licen[cs]e)s?\b/i.test(s)) return 'seat';
  if (/\bcu[- ]?(hour|hr)s?\b/i.test(s)) return 'cu_hour';
  if (/\bgb[- ]?(month|mo)\b/i.test(s) || /\bper gb\b|\/\s*gb\b/i.test(s)) return 'gb';
  if (/\b(request|call|query)s?\b/i.test(s)) return 'request';
  return null;
}

/**
 * "billed annually", "annual billing", "paid yearly" describe how often you PAY, not what the number
 * is per: "$9/seat (billed annually)" is $9 per seat per month on an annual contract. Strip them so
 * only a real price period ("/yr", "per year") can make an amount yearly. They are kept separately
 * as the `billing` qualifier.
 */
const BILLING_CADENCE =
  /\b(?:(?:when\s+)?(?:billed|paid|payable|charged|invoiced)\s+(?:annually|yearly|monthly|per\s+(?:year|month)|every\s+(?:year|month)|upfront|in advance)|(?:annual|yearly|monthly)\s+(?:billing|contract|commitment|plan|subscription|prepay(?:ment)?))\b/gi;

const ANNUAL_TERMS = /\b(?:billed|paid|payable|charged|invoiced)\s+(?:annually|yearly|per\s+year|every\s+year|upfront|in advance)\b|\b(?:annual|yearly)\s+(?:billing|contract|commitment|plan|subscription|prepay(?:ment)?)\b|\bon an annual\b/i;
const MONTHLY_TERMS = /\b(?:billed|paid|charged|invoiced)\s+(?:monthly|per\s+month|every\s+month)\b|\bmonth[- ]to[- ]month\b|\bmonthly\s+(?:billing|contract|commitment|plan|subscription)\b|\bno annual (?:commitment|contract)\b/i;
const AWS_REGION = /\b(us|eu|ap|sa|ca|me|af|il)-(east|west|north|south|central|northeast|southeast|northwest|southwest)-\d\b/i;
const NAMED_REGION = /\b(?:in|for)\s+(?:the\s+)?(EU|EEA|Europe|UK|India|US|United States|Australia|Japan|Brazil)\b/i;

/** Billing commitment and region stated in `text`, if any. Both commitments stated → unknown. */
export function detectQualifiers(text: string | null | undefined): Qualifiers {
  if (!text) return {};
  const q: Qualifiers = {};
  const annual = ANNUAL_TERMS.test(text);
  const monthly = MONTHLY_TERMS.test(text);
  if (annual !== monthly) q.billing = annual ? 'annual' : 'monthly';
  const r = AWS_REGION.exec(text) ?? NAMED_REGION.exec(text);
  if (r) q.region = (r[0].match(AWS_REGION) ? r[0] : r[1]).toLowerCase().replace(/^united states$/, 'us').replace(/^europe$/, 'eu');
  return q;
}

export function mergeQualifiers(...qs: (Qualifiers | null | undefined)[]): Qualifiers {
  const out: Qualifiers = {};
  for (const q of qs) {
    if (!q) continue;
    if (q.billing && !out.billing) out.billing = q.billing;
    if (q.region && !out.region) out.region = q.region;
  }
  return out;
}

export function parseQualifiers(json: string | null | undefined): Qualifiers {
  if (!json) return {};
  try {
    const q = JSON.parse(json) as Qualifiers;
    return q && typeof q === 'object' ? q : {};
  } catch {
    return {};
  }
}

function detectPeriod(raw: string): { period: Money['period']; yearly: boolean } {
  const s = raw.replace(BILLING_CADENCE, ' ');
  // An explicit "/mo" wins over "billed annually": "$25/user/mo billed annually" is a monthly price.
  if (/(\/|\bper\b|\ba\b)\s*(mo|mon|month)\b|\bmonthly\b|\bmonth\b|\bmo\b|\bp\/?m\b/i.test(s)) return { period: 'month', yearly: false };
  if (/(\/|\bper\b|\ba\b)\s*(yr|year|annum)\b|\bannual(ly)?\b|\byearly\b|\byear\b|\byr\b|\bp\.?a\.?\b/i.test(s)) return { period: 'month', yearly: true };
  if (/(\/|\bper\b)\s*(hr|hour)\b|\bhourly\b/i.test(s) && !/cu[- ]?(hour|hr)/i.test(s)) return { period: 'hour', yearly: false };
  if (/\bone[- ]time\b|\blifetime\b/i.test(s)) return { period: 'one_time', yearly: false };
  return { period: 'none', yearly: false };
}

/** Parse a price-like string. Returns null when there is no number to compare. */
export function parseMoney(raw: string | null | undefined): Money | null {
  if (!raw) return null;
  const s = raw.replace(/ /g, ' ').trim();
  if (!s) return null;
  const basis = detectBasis(s);
  if (/^\s*(free|\$?0(\.0+)?)\s*(\/|per|$)/i.test(s) || /^free\b/i.test(s)) {
    return { amount: 0, currency: 'ANY', period: detectPeriod(s).period, basis, free: true, stated: 0, decimals: 0, converted: false };
  }
  // Skip numbers that are part of the basis ("per 1M tokens", "1 million"), take the first price-like number.
  const scrubbed = s.replace(/\b(per|\/)\s*1\s*(m|k|million|thousand)\b/gi, ' ').replace(/\b1\s*(m|million)\s+tokens?/gi, ' tokens');
  const num = scrubbed.match(/(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(k)?\b/i);
  if (!num) return null;
  let amount = Number((num[1] + (num[2] ?? '')).replace(/,/g, ''));
  const decimals = num[2] ? num[2].length - 1 : 0;
  if (num[3]) amount *= 1000;
  // Currency only when written: "19 per month" is not assumed to be dollars.
  let currency = 'UNKNOWN';
  for (const [re, code] of CURRENCY_SYMBOLS) {
    if (re.test(s)) {
      currency = code;
      break;
    }
  }
  const stated = amount;
  const { period, yearly } = detectPeriod(s);
  if (yearly) amount = amount / 12;
  return { amount, currency, period, basis, free: amount === 0, stated, decimals, converted: yearly };
}

export function joinValue(c: { value: string; unit?: string | null; period?: string | null }): string {
  return [c.value, c.unit, c.period ? (/(^per |^\/)/.test(c.period) ? c.period : `per ${c.period}`) : '']
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
}

/**
 * Precision-aware equality. Without a unit conversion the amounts must be equal (so $0.001 and
 * $0.002 differ). When exactly one side was converted from a yearly price, allow the rounding of
 * the side as written: half a unit of its last decimal place ($8.33/mo vs $100/yr).
 */
export function sameAmount(a: Money, b: Money): boolean {
  const exact = (x: number, y: number) => Math.abs(x - y) <= 1e-12 * Math.max(1, Math.abs(x), Math.abs(y));
  if (a.converted === b.converted) return a.converted ? exact(a.stated, b.stated) : exact(a.amount, b.amount);
  const written = a.converted ? b : a;
  return Math.abs(a.amount - b.amount) <= 0.5 * 10 ** -written.decimals + 1e-12;
}

export interface CompareResult {
  status: DiffStatus;
  note?: string;
  /** false when the two values could not be put on the same basis (currency/unit/period/terms). */
  comparable?: boolean;
}

/**
 * Compare a stored value with a freshly found one. `next` null means nothing usable was found.
 * Qualifiers stated in the value strings are detected and merged with the ones passed in.
 */
export function compareValues(prev: string, next: string | null, q: { prev?: Qualifiers; next?: Qualifiers } = {}): CompareResult {
  if (next == null || !next.trim()) return { status: 'cant_verify', note: 'current value not found in the sources' };
  const a = parseMoney(prev);
  const b = parseMoney(next);
  if (a && b) {
    const nc = (note: string): CompareResult => ({ status: 'cant_verify', note, comparable: false });
    if (a.free && b.free) return { status: 'unchanged', comparable: true };
    if (!a.free && !b.free && a.currency !== b.currency) {
      if (a.currency === 'UNKNOWN' || b.currency === 'UNKNOWN') return nc('currency stated on only one side');
      return nc(`different currencies (${a.currency} vs ${b.currency})`);
    }
    if (a.basis !== b.basis) {
      if (!a.basis || !b.basis) return nc(`unit stated on only one side (${a.basis ?? 'none'} vs ${b.basis ?? 'none'})`);
      return nc(`not comparable (${a.basis} vs ${b.basis})`);
    }
    const qa = mergeQualifiers(q.prev, detectQualifiers(prev));
    const qb = mergeQualifiers(q.next, detectQualifiers(next));
    if (a.period !== b.period) {
      if (a.period === 'none' || b.period === 'none') {
        // The SAME number for the same unit and terms, with the period written on only one side
        // ("$9/seat (billed annually)" today vs "$9 per seat per month, billed annually" then): nothing
        // points to a change. A different number can't be read this way, so it stays not comparable.
        // Live regression: HubSpot's own page re-read with the same $9 was shown as "not comparable".
        // Billing/region terms must agree (both stated and equal, or both unstated), as for any match.
        const termsAgree = (['billing', 'region'] as const).every((k) => (qa[k] ?? null) === (qb[k] ?? null));
        if (!a.free && !b.free && !a.converted && !b.converted && a.stated === b.stated && termsAgree)
          return { status: 'unchanged', note: 'same amount; the source does not state the billing period', comparable: true };
        return nc('billing period stated on only one side');
      }
      return nc(`different billing periods (${a.period} vs ${b.period})`);
    }
    const oneSided: string[] = [];
    for (const k of ['billing', 'region'] as const) {
      if (qa[k] && qb[k] && qa[k] !== qb[k]) return nc(`different ${k} terms (${qa[k]} vs ${qb[k]})`);
      if (!!qa[k] !== !!qb[k]) oneSided.push(k);
    }
    const same = a.free !== b.free ? false : sameAmount(a, b);
    if (oneSided.length)
      return nc(`${same ? 'same number' : `${fmt(a)} → ${fmt(b)}`}, but the ${oneSided.join(' and ')} terms are stated on only one side`);
    return same ? { status: 'unchanged', comparable: true } : { status: 'changed', note: `${fmt(a)} → ${fmt(b)}`, comparable: true };
  }
  if (!a && !b) return normText(prev) === normText(next) ? { status: 'unchanged', comparable: true } : { status: 'changed', note: 'text differs', comparable: true };
  return { status: 'cant_verify', note: 'values are not in a comparable form', comparable: false };
}

function fmt(m: Money): string {
  if (m.free) return 'free';
  const per = m.period === 'month' ? '/mo' : m.period === 'hour' ? '/hr' : '';
  const basis = m.basis ? ` per ${m.basis.replace('_', ' ')}` : '';
  const cur = m.currency === 'UNKNOWN' ? '' : `${m.currency} `;
  return `${cur}${m.converted ? `${m.stated}/yr` : `${m.amount}${per}`}${basis}`;
}

/** Does the number in `value` literally appear in `text`? Guards against hallucinated extractions. */
export function valueAppearsIn(value: string, text: string): boolean {
  const nums = value.replace(/,/g, '').match(/\d+(\.\d+)?/g);
  if (!nums) return /free/i.test(value) ? /free/i.test(text) : false;
  const hay = text.replace(/,/g, '');
  return nums.every((n) => {
    // Allow trailing-zero variants: "15" ≈ "15.00", "0.3" ≈ "0.30".
    const base = n.includes('.') ? n.replace(/0+$/, '').replace(/\.$/, '') : n;
    const tail = base.includes('.') ? '0*' : '(?:\\.0+)?';
    return new RegExp(`(^|[^0-9.])${base.replace('.', '\\.')}${tail}(?![0-9])`).test(hay);
  });
}
