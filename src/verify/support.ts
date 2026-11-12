// Code check: does a cited source really state this value FOR THIS ENTITY?
// The number must appear in the evidence, and the entity's distinguishing words must appear in
// the heading of the section the number sits in (or the page title/domain). This catches
// "Gemini 2.5 Pro: $0.30" cited to a page section headed "## Gemini 2.5 Flash".

import type { Evidence } from '../search/postprocess.js';
import { sectionTokens } from '../search/postprocess.js';
import { valueAppearsIn } from './diff.js';

// Category words in product names ("Zoho CRM", "Neon Postgres") that a vendor page may omit.
export const CATEGORY_WORDS = new Set(['crm', 'postgres', 'postgresql', 'cloud', 'hosting', 'database', 'db', 'sales', 'platform', 'inc', 'ai', 'managed', 'serverless']);

export interface Support {
  ok: boolean;
  sourceId: string | null;
  reason?: string;
}

/**
 * Split a focused excerpt back into its heading sections. `heading` is the full heading PATH
 * ("Gemini 2.5 Flash › Standard"): pricing pages nest tier tables ("### Standard", "### Batch")
 * under the product heading, and the product name lives only in the ancestor.
 */
export function sections(text: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  const stack: { level: number; text: string }[] = [];
  let cur = { heading: '', body: '' };
  for (const line of text.split('\n')) {
    const m = /^(#{1,4})\s+(.+)$/.exec(line);
    if (m) {
      if (cur.body.trim() || cur.heading) out.push(cur);
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: m[2].trim() });
      cur = { heading: stack.map((h) => h.text).join(' › '), body: '' };
    } else if (line.trim() === '…') {
      // Excerpts of several page sections are joined with "…": what follows starts a fresh path.
      if (cur.body.trim() || cur.heading) out.push(cur);
      stack.length = 0;
      cur = { heading: '', body: '' };
    } else cur.body += line + '\n';
  }
  out.push(cur);
  return out;
}

export function supportedBy(value: string, entity: string, ev: Evidence): Support {
  const hay = `${ev.title}\n${ev.excerpt}`;
  if (!valueAppearsIn(value, hay)) return { ok: false, sourceId: ev.id, reason: `value not in ${ev.id}` };
  const need = [...new Set(sectionTokens(entity))].filter((t) => !CATEGORY_WORDS.has(t));
  // A "product" made only of generic words ("Input", "Price") is a parsing artefact, not something to remember.
  if (!need.length) return { ok: false, sourceId: ev.id, reason: `"${entity}" is not a product name` };
  const context = sectionTokens(`${ev.title} ${ev.domain.replace(/\./g, ' ')}`);
  const secs = sections(ev.excerpt).filter((s) => valueAppearsIn(value, `${s.heading}\n${s.body}`));
  // Value found only in the title, or the excerpt has no headings: the entity must be named somewhere in the source.
  if (!secs.length || secs.every((s) => !s.heading)) {
    const all = new Set([...context, ...sectionTokens(ev.excerpt)]);
    return need.every((t) => all.has(t)) ? { ok: true, sourceId: ev.id } : { ok: false, sourceId: ev.id, reason: `${ev.id} does not mention ${entity}` };
  }
  for (const s of secs) {
    const heading = sectionTokens(s.heading);
    const scope = new Set([...context, ...heading]);
    // "Gemini 2.5 Flash Native Audio" contains every word of "Gemini 2.5 Flash" but is another model.
    const variant = heading.filter((t) => VARIANT_WORDS.has(t) && !need.includes(t));
    if (need.every((t) => scope.has(t)) && !variant.length) return { ok: true, sourceId: ev.id };
  }
  return { ok: false, sourceId: ev.id, reason: `in ${ev.id} the value sits under "${secs[0].heading}", not ${entity}` };
}

/**
 * Words that turn a product name into a DIFFERENT product (a model variant), not a plan of it:
 * "Gemini 2.5 Flash-Lite", "… Native Audio", "… Image Preview", "GPT-4o mini". Plan names such as
 * Pro, Plus, Max or Starter are deliberately absent: "HubSpot" priced under "Sales Hub Starter" is
 * still HubSpot. Live regression: an ai.google.dev "Gemini 2.5 Flash Native Audio" price ($2.00)
 * was answered as the Gemini 2.5 Flash price.
 */
export const VARIANT_WORDS = new Set(['lite', 'mini', 'nano', 'micro', 'preview', 'audio', 'native', 'image', 'images', 'tts', 'live', 'embedding', 'embeddings', 'realtime', 'vision', 'transcribe']);

/** Supported by at least one of the cited sources? */
export function supportedByAny(value: string, entity: string, sourceIds: string[], byId: Map<string, Evidence>): Support {
  if (!sourceIds.length) return { ok: false, sourceId: null, reason: 'no citation' };
  let last: Support = { ok: false, sourceId: null, reason: 'cited source not found' };
  for (const id of sourceIds) {
    const ev = byId.get(id);
    if (!ev) continue;
    const s = supportedBy(value, entity, ev);
    if (s.ok) return s;
    last = s;
  }
  return last;
}

/** Distinguishing words of a product name ("Gemini 2.5 Flash" → gemini, 2.5, flash; "Zoho CRM" → zoho). */
export function entityNeed(entity: string): string[] {
  return [...new Set(sectionTokens(entity))].filter((t) => !CATEGORY_WORDS.has(t));
}

/** Does `text` name `entity`? Strict: every distinguishing word must appear (2.5 Pro ≠ 2.5 Flash). */
export function entityMentioned(entity: string, text: string): boolean {
  const need = entityNeed(entity);
  if (!need.length) return false;
  const have = new Set(sectionTokens(text));
  return need.every((t) => have.has(t));
}

/** Loose: the brand (first distinguishing word) appears. For announcements about a vendor. */
export function brandMentioned(entity: string, text: string): boolean {
  const need = entityNeed(entity).filter((t) => !/^\d/.test(t));
  if (!need.length) return false;
  return new Set(sectionTokens(text)).has(need[0]);
}
