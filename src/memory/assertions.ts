// Memory writer: links the DELIVERED answer to the source observations it used, synchronously,
// before the turn is reported complete. The answer's markdown is not parsed as the data interface:
// an assertion is recorded when a segment of the answer (a table row, a bullet or a sentence) cites a
// source [S#], states a number that source's observation states, and names that observation's
// product. Table, prose and mixed formatting therefore produce the same answer-linked facts, and
// the stored value/unit/plan/qualifiers come from the observation, not from the answer's wording.
//
// Also recorded: price statements no observation supports (status "unsupported", never a baseline),
// estimates, material non-price statements ("Neon has no monthly minimum") as cited/uncited facts,
// and the items + constraints the user named (even when no web search ran).

import type { Observation } from '../evidence/observations.js';
import type { Evidence } from '../search/postprocess.js';
import { valueAppearsIn } from '../verify/diff.js';
import { brandMentioned, entityMentioned, entityNeed, supportedByAny } from '../verify/support.js';
import { sectionTokens } from '../search/postprocess.js';
import { planMatch } from '../verify/reverify.js';
import { getDb, insertEntitySet, setMemoryStatus } from './db.js';
import { COMPUTED_HEADER, type ParsedClaim, cleanText, normalizeText, parseClaims, parseEntityList, parseNameList } from './parseClaims.js';

const CITE = /\[(S\d+)\]/g;
const SEP = /^\s*\|?\s*:?-{2,}/;
const MONEY = /(?:US\$|\$|€|£|₹)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR)\b/;
const APPROX = /(≈|~|\babout\b|\baround\b|\broughly\b|\bapprox|\bestimate|\btypical|\bup to\b)/i;

const citations = (s: string) => [...new Set([...s.matchAll(CITE)].map((m) => m[1]))];
const splitRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export interface Segment {
  text: string; // the row / sentence
  context: string; // heading, bold lead or table header that names the product
  cites: string[];
  table: boolean;
}

/** Split an answer into the units a fact can be stated in: table rows, bullets, sentences. */
export function segments(answer: string): Segment[] {
  const lines = normalizeText(answer).split('\n');
  const out: Segment[] = [];
  let heading = '';
  let header: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) {
      header = null;
      continue;
    }
    if (t.startsWith('|')) {
      if (lines[i + 1] && SEP.test(lines[i + 1])) {
        header = splitRow(t).map(cleanText);
        i++;
        continue;
      }
      if (SEP.test(t)) continue;
      const cells = splitRow(t);
      // Drop the model's own arithmetic columns ("20 seats", "Total"): not source facts.
      const kept = cells.filter((_c, k) => !(header && COMPUTED_HEADER.test(header[k] ?? '')));
      out.push({ text: kept.join(' | '), context: `${heading} ${header?.join(' ') ?? ''}`, cites: citations(kept.join(' ')), table: true });
      continue;
    }
    header = null;
    const h = /^(#{1,4})\s+(.+)$/.exec(t);
    const bold = /^\*\*([^*]+)\*\*\s*:?\s*$/.exec(t);
    if (h || (bold && !MONEY.test(t))) {
      heading = cleanText(h ? h[2] : bold![1]);
      continue;
    }
    const body = t.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').replace(/^>\s*/, '');
    const lead = /^\*\*([^*]+)\*\*/.exec(body)?.[1] ?? '';
    for (const s of body.split(/(?<=[.!?])\s+(?=[A-Z*"“(])/)) {
      if (s.trim()) out.push({ text: s.trim(), context: `${heading} ${lead}`, cites: citations(s), table: false });
    }
  }
  return out;
}

export type AssertionStatus = 'supported' | 'unsupported' | 'estimate' | 'cited' | 'uncited';

export interface Assertion {
  kind: 'price' | 'fact' | 'event';
  entity: string;
  plan: string | null;
  attribute: string;
  value: string;
  unit: string | null;
  period: string | null;
  status: AssertionStatus;
  sourceLabel: string | null;
  observation: Observation | null;
  span: string;
}

const PLAN_GENERIC = new Set(['plan', 'tier', 'edition', 'package', 'the']);
function planMentioned(plan: string, entity: string, text: string): boolean {
  const own = new Set(sectionTokens(entity));
  const words = sectionTokens(plan).filter((w) => !own.has(w) && !PLAN_GENERIC.has(w));
  if (!words.length) return true;
  const have = new Set(sectionTokens(text));
  return words.some((w) => have.has(w));
}

const STOP = new Set(['the', 'and', 'for', 'with', 'its', 'new', 'now', 'has', 'have', 'that', 'this', 'from', 'into', 'will', 'are', 'was', 'launches', 'launched', 'announces', 'announced', 'introduces', 'introduced']);
const overlap = (a: string, b: string) => {
  const A = new Set(sectionTokens(a).filter((w) => w.length >= 4 && !STOP.has(w)));
  return sectionTokens(b).filter((w) => A.has(w)).length;
};

/**
 * The answer's assertions, linked to the observations they used. Pure code, ~1 ms.
 * `factText`: the part of the answer the model wrote (non-price statements are read from it only).
 */
export function linkAnswer(answer: string, evidence: Evidence[], opts: { entities?: string[]; factText?: string } = {}): Assertion[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const out: Assertion[] = [];
  const usedObs = new Set<string>();

  for (const seg of segments(answer)) {
    if (!seg.cites.length) continue;
    const hay = `${seg.context} ${seg.text}`;
    for (const id of seg.cites) {
      const ev = byId.get(id);
      if (!ev) continue;
      const obs = ev.observations ?? [];
      for (const o of obs) {
        if (usedObs.has(o.id)) continue;
        if (o.kind === 'price') {
          if (!valueAppearsIn(o.value, seg.text) || !entityMentioned(o.entity, hay)) continue;
          if (o.plan && !planMentioned(o.plan, o.entity, hay)) {
            // The answer didn't name the plan: link only if this source states that value for one plan.
            const rivals = obs.filter((x) => x.kind === 'price' && x !== o && x.entity === o.entity && valueAppearsIn(x.value, seg.text));
            if (rivals.length) continue;
          }
          const i = seg.text.search(new RegExp(o.value.replace(/[$€£₹]/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          const approx = i > 0 && APPROX.test(seg.text.slice(Math.max(0, i - 24), i));
          usedObs.add(o.id);
          out.push({ kind: 'price', entity: o.entity, plan: o.plan, attribute: o.attribute, value: o.value, unit: o.unit, period: o.period, status: approx ? 'estimate' : 'supported', sourceLabel: id, observation: o, span: seg.text.slice(0, 300) });
        } else if (o.kind === 'event') {
          if (!brandMentioned(o.entity, hay) || overlap(o.value, seg.text) < 2) continue;
          usedObs.add(o.id);
          out.push({ kind: 'event', entity: o.entity, plan: null, attribute: 'announcement', value: o.value, unit: null, period: null, status: 'cited', sourceLabel: id, observation: o, span: seg.text.slice(0, 300) });
        }
      }
    }
  }

  // Price statements no observation supports: what we said, but never a comparison baseline.
  const linked = out.filter((a) => a.kind === 'price');
  for (const c of parseClaims(answer)) {
    if (linked.some((a) => valueAppearsIn(a.value, c.value) && (entityMentioned(a.entity, c.entity) || entityMentioned(c.entity, a.entity)))) continue;
    if (out.some((a) => a.status !== 'supported' && a.entity === c.entity && a.value === c.value)) continue;
    out.push({ kind: 'price', entity: c.entity, plan: c.plan, attribute: c.attribute, value: c.value, unit: c.unit, period: c.period, status: c.approximate ? 'estimate' : 'unsupported', sourceLabel: c.sources[0] ?? null, observation: null, span: '' });
  }

  // Material non-price statements about the products in play.
  const entities = [...new Set(opts.entities ?? [])].filter((e) => entityNeed(e).length);
  if (entities.length && opts.factText) {
    const mentions = (e: string, s: string) => entityMentioned(e, s) || entityNeed(e).some((t) => t.length >= 3 && !/^\d/.test(t) && new Set(sectionTokens(s)).has(t));
    let facts = 0;
    for (const seg of segments(opts.factText)) {
      if (seg.table || MONEY.test(seg.text)) continue;
      for (const clause of seg.text.split(/,\s*(?:and\s+|while\s+|but\s+)?(?=[A-Z])|;\s*/)) {
        const s = cleanText(clause).replace(/^and\s+/i, '');
        if (s.length < 20 || s.length > 260 || /\?$/.test(s)) continue;
        if (/^(I|I'm|I've|I'd|We|We've|Let|Note|Tip|If you|Interpretation|Sources?|Want|Would you)\b/i.test(s)) continue;
        if (!/\b(is|are|has|have|offers?|includes?|bills?|charges?|supports?|requires?|lacks?|does not|doesn't|no longer|provides?|comes? with|uses?)\b/i.test(s)) continue;
        const e = entities.find((x) => mentions(x, s));
        if (!e || facts >= 8) continue;
        facts++;
        const cites = seg.cites;
        out.push({ kind: 'fact', entity: e, plan: null, attribute: 'statement', value: s, unit: null, period: null, status: cites.length ? 'cited' : 'uncited', sourceLabel: cites[0] ?? null, observation: null, span: seg.text.slice(0, 300) });
      }
    }
  }
  return out;
}

/** Constraints the user stated ("20-person sales team", "under $50/month", "in the EU"). */
export function extractConstraints(text: string): Record<string, string> {
  const t = normalizeText(text);
  const out: Record<string, string> = {};
  const team = /\b\d+[- ](?:person|people|member|seat|user|rep|engineer|developer)s?(?:\s+[a-z]+){0,2}\s+team\b|\bteam of \d+(?:\s+\w+)?\b|\b\d+\s+(?:seats|users|people|reps|sales reps|engineers|developers)\b/i.exec(t);
  if (team) out.team_size = team[0];
  const budget = /\b(?:under|below|less than|max(?:imum)?|budget(?: of)?|up to|no more than)\s+(?:US\$|\$|€|£|₹)\s?\d[\d,]*(?:\.\d+)?(?:\s*(?:\/|per)\s*[a-z]+)*/i.exec(t);
  if (budget) out.budget = budget[0];
  const region = /\b(?:in|for|based in|hosted in)\s+(?:the\s+)?(EU|Europe|UK|India|US|USA|United States|Germany|France|Canada|Australia|Japan|Singapore|Brazil)\b/.exec(t);
  if (region) out.region = region[1];
  const purpose = /\bfor (?:a|an|our|my) ((?:small|large|early|growing|new|b2b|b2c|production|side|startup|\d+[- ]\w+)[^.,?!]{2,60})/i.exec(t);
  if (purpose && !(out.team_size && purpose[1].includes(out.team_size.split(' ')[0]))) out.purpose = purpose[1].trim();
  return out;
}

export interface RecordResult {
  supported: number;
  unsupported: number;
  estimates: number;
  facts: number;
  events: number;
  sets: number;
  constraints: Record<string, string>;
}

/**
 * Persist the turn's answer-linked memory in one transaction. Runs before the final event, so the
 * next turn sees exactly what was delivered. Only observations the answer used are stored.
 */
export function recordTurnMemory(opts: {
  messageId: number;
  userText: string;
  answerText: string; // the final delivered text
  factText?: string; // the model-written part (non-price statements are read from it)
  evidence: Evidence[];
  sourceIds: Map<string, number>; // S1 → sources.id
  asOf: string; // YYYY-MM-DD
  entities?: string[];
}): RecordResult {
  const answerList = parseEntityList(opts.answerText);
  const list = answerList.length >= 2 ? answerList : parseNameList(opts.userText);
  const entities = [...new Set([...(opts.entities ?? []), ...list])];
  const assertions = opts.evidence.length || opts.factText ? linkAnswer(opts.answerText, opts.evidence, { entities, factText: opts.factText }) : [];
  const constraints = extractConstraints(opts.userText);

  const db = getDb();
  const insObs = db.prepare(
    `INSERT INTO observations (source_id, message_id, kind, entity, plan, attribute, value, unit, period, qualifiers_json, span, published_at, observed_at, effective_date, event_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insClaim = db.prepare(
    `INSERT INTO claims (message_id, entity, attribute, value, unit, period, plan, as_of, source_id, confidence, kind, status, observation_id, qualifiers_json, span)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const obsRow = new Map<string, number>();
  db.exec('BEGIN');
  try {
    for (const a of assertions) {
      const sid = a.sourceLabel ? (opts.sourceIds.get(a.sourceLabel) ?? null) : null;
      let oid: number | null = null;
      if (a.observation && sid !== null) {
        const o = a.observation;
        oid = obsRow.get(o.id) ?? null;
        if (oid === null) {
          const r = insObs.run(sid, opts.messageId, o.kind, o.entity, o.plan, o.attribute, o.value, o.unit, o.period, JSON.stringify(o.qualifiers ?? {}), o.span, o.publishedAt, o.observedAt, o.effectiveDate, o.eventDate);
          oid = Number(r.lastInsertRowid);
          obsRow.set(o.id, oid);
        }
      }
      const conf = a.status === 'supported' ? 0.95 : a.status === 'estimate' ? 0.5 : a.status === 'cited' ? 0.6 : 0;
      insClaim.run(opts.messageId, a.entity, a.attribute, a.value, a.unit, a.period, a.plan, opts.asOf, sid, conf, a.kind, a.status, oid, a.observation ? JSON.stringify(a.observation.qualifiers ?? {}) : null, a.span || null);
    }
    if (list.length >= 2 || Object.keys(constraints).length) insertEntitySet(opts.messageId, opts.userText.replace(/\s+/g, ' ').slice(0, 100), list.length >= 2 ? list : [], constraints);
    setMemoryStatus(opts.messageId, 'complete');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    try {
      setMemoryStatus(opts.messageId, 'failed');
    } catch {}
    throw e;
  }
  const count = (k: Assertion['kind'], s?: AssertionStatus) => assertions.filter((a) => a.kind === k && (!s || a.status === s)).length;
  return {
    supported: count('price', 'supported'),
    unsupported: count('price', 'unsupported'),
    estimates: count('price', 'estimate'),
    facts: count('fact'),
    events: count('event'),
    sets: list.length >= 2 || Object.keys(constraints).length ? 1 : 0,
    constraints,
  };
}

export interface CheckedClaim extends ParsedClaim {
  supported: boolean;
  sourceId: string | null; // the S-id that supports it
  reason?: string;
}

/** Parse cited prices from an answer and check each against its cited evidence (warnings). */
export function checkAnswerClaims(answer: string, evidence: Evidence[]): CheckedClaim[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  return parseClaims(answer).map((c) => {
    const s = supportedByAny(c.value, c.entity, c.sources, byId);
    const wrongPlan = s.ok && c.plan && s.sourceId ? planConflict(c, byId.get(s.sourceId)) : null;
    if (wrongPlan) return { ...c, supported: false, sourceId: s.sourceId, reason: wrongPlan };
    return { ...c, supported: s.ok, sourceId: s.sourceId, reason: s.reason };
  });
}

/**
 * The cited source states the value, but only for ANOTHER plan of the product.
 * Live regression: Neon "Launch" compute "$0.222 / CU-hour" — $0.222 is Neon's Scale-plan price.
 */
function planConflict(c: ParsedClaim, ev: Evidence | undefined): string | null {
  if (!ev || !c.plan) return null;
  const same = (ev.observations ?? []).filter(
    (o) => o.kind === 'price' && valueAppearsIn(c.value, o.value) && (entityMentioned(o.entity, c.entity) || entityMentioned(c.entity, o.entity)),
  );
  if (!same.length || !same.every((o) => o.plan && planMatch(c.plan, o.plan, c.entity, '') === 'mismatch')) return null;
  return `${ev.id} lists ${c.value} under the ${same[0].plan} plan, not ${c.plan}`;
}
