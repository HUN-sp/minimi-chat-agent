// A short reply to the assistant's own clarifying question ("3 Nov", "the first one", "the 10th")
// is resolved against the question that is still pending, so the turn is routed, recalled and
// guarded as the question the user actually asked.
//
// Live regression: after "Which 'last Tuesday' do you mean — Tue 10 Nov or Tue 3 Nov?", the reply
// "3 Nov" was routed as a brand-new, memory-less turn (no recall, no change intent, so none of the
// "then" guards ran). The model re-priced everything from today's search results and invented
// "same as $10 (3 Nov)" values that were never recorded.

import type { MessageRow } from '../memory/db.js';
import { resolveDates } from '../time/resolve.js';

export interface Clarification {
  /** The pending question with the ambiguous phrase replaced by the chosen date. */
  effective: string;
  /** The chosen candidate, e.g. "Tue 3 Nov 2026". */
  label: string;
  /** YYYY-MM-DD of the chosen candidate. */
  from: string;
  /** The user's earlier, ambiguous question. */
  pending: string;
}

interface Option {
  label: string;
  from: string;
}

interface Pending {
  question: string;
  phrase: string;
  options: Option[];
  asked: string; // the assistant's clarifying message
}

/** The assistant's last message asked which of several candidate dates was meant. */
function pendingFrom(history: MessageRow[]): Pending | null {
  const last = history[history.length - 1];
  if (!last || last.role !== 'assistant' || last.failed) return null;
  // It must actually ask something.
  if (!/\?/.test(last.content.slice(-400))) return null;
  const user = [...history].reverse().find((m) => m.role === 'user' && m.id < last.id);
  if (!user) return null;
  let meta: any = null;
  try {
    meta = JSON.parse(last.meta_json ?? 'null');
  } catch {
    return null;
  }
  const windows: { phrase: string; label: string; from: string; group: number }[] = Array.isArray(meta?.windows) ? meta.windows : [];
  const groups = new Map<number, typeof windows>();
  for (const w of windows) groups.set(w.group, [...(groups.get(w.group) ?? []), w]);
  const amb = [...groups.values()].find((g) => g.length >= 2);
  if (!amb) return null;
  // Retrieval may have narrowed the candidates to the dates that hold conversations.
  const named: string[] | undefined = meta?.memory?.ambiguous?.options;
  const options = named?.length ? amb.filter((w) => named.includes(w.label)) : amb;
  if (options.length < 2) return null;
  return { question: user.content, phrase: amb[0].phrase, options: options.map((w) => ({ label: w.label, from: w.from })), asked: last.content };
}

const day = (iso: string) => Number(iso.slice(8, 10));

function choose(message: string, p: Pending, now: Date, tz: string): Option | null {
  const text = message.toLowerCase();
  // An explicit date ("3 Nov", "Tuesday 3 November", "2026-11-03").
  const ws = resolveDates(message, now, tz);
  const byDate = p.options.filter((o) => ws.some((w) => w.from <= o.from && o.from <= w.to && w.from === w.to));
  if (byDate.length === 1) return byDate[0];
  // "the 3rd", "10th".
  const ord = /\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (ord) {
    const hits = p.options.filter((o) => day(o.from) === Number(ord[1]));
    if (hits.length === 1) return hits[0];
  }
  const byTime = [...p.options].sort((a, b) => a.from.localeCompare(b.from));
  if (/\b(earlier|older|before|previous|week before)\b/.test(text)) return byTime[0];
  if (/\b(later|latest|more recent|recent|most recent|this week)\b/.test(text)) return byTime[byTime.length - 1];
  // "the first one" / "the second": in the order the clarifying message listed them.
  const listed = [...p.options].sort((a, b) => position(p.asked, a) - position(p.asked, b));
  if (/\b(first|former|1st)\b/.test(text)) return listed[0];
  if (/\b(second|latter|2nd|last one)\b/.test(text)) return listed[1];
  return null;
}

function position(text: string, o: Option): number {
  const short = o.label.replace(/^\w{3}\s+/, '').replace(/\s+\d{4}$/, ''); // "Tue 3 Nov 2026" → "3 Nov"
  const i = text.indexOf(short);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/**
 * @returns null unless `message` is a short answer to a pending "which date did you mean?" question.
 */
export function resolveClarification(message: string, history: MessageRow[], now: Date, tz: string): Clarification | null {
  const m = message.trim();
  if (!m || m.length > 60) return null;
  const p = pendingFrom(history);
  if (!p) return null;
  const pick = choose(m, p, now, tz);
  if (!pick) return null;
  const re = new RegExp(`\\b(?:on\\s+)?${p.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const effective = re.test(p.question) ? p.question.replace(re, `on ${pick.label}`) : `${p.question.replace(/\s*\?\s*$/, '')} (on ${pick.label})?`;
  return { effective, label: pick.label, from: pick.from, pending: p.question };
}
