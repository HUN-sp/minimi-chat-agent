// Guard for the model-written part of a re-check answer. The comparison (verdict, Then/Now values,
// statuses) is rendered in code above it; the model's text must not contradict or re-invent it:
//   • a model-written Then/Now table is dropped (the code table is authoritative);
//   • a blanket verdict ("nothing changed", "your answer is still correct") survives only if every
//     row is Unchanged and no earlier non-price statement is outstanding;
//   • a per-item verdict ("HubSpot is unchanged") survives only if that item's rows are Unchanged;
//   • an earlier value ("was $25 on Monday") survives only if it is a stored answer assertion for an
//     item the sentence names. Today's sources never establish what we said before.
// Works on tables, bullets and prose alike, so reformatting the answer cannot get around it.

import type { ClaimRow } from '../memory/db.js';
import type { Evidence } from '../search/postprocess.js';
import { cleanText } from '../memory/parseClaims.js';
import type { Comparison } from '../verify/reverify.js';
import { valueAppearsIn } from '../verify/diff.js';
import { entityMentioned, entityNeed } from '../verify/support.js';
import { sectionTokens } from '../search/postprocess.js';
import { explicitDate } from '../evidence/observations.js';

const SEP = /^\s*\|?\s*:?-{2,}/;
const THEN_COL = /\b(then|before|previous(ly)?|earlier|was|old|stored|recorded|what (we|i) said)\b/i;
const NOW_COL = /\b(now|today|current(ly)?|latest|after|new|status|change[ds]?|verdict|result)\b/i;
const MONEY = /(?:US\$|\$|€|£|₹)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR)\b/g;

const BLANKET =
  /\b(nothing (?:else |further )?(?:has |have )?changed|no (?:further |other |additional |more |new )?(?:price |pricing )?changes?\b|none of (?:them|these|those|the \w+) (?:has |have )?changed|(?:all|every)(?: of)?(?: the| these| those| your)?(?: \w+)? (?:are|is|remain(?:ed|s)?|stayed?) (?:unchanged|the same|current|correct|accurate)|(?:is|are|remains?) still (?:correct|accurate|valid|current|up to date)|still (?:holds?|stands)|everything (?:is )?(?:still )?(?:the same|unchanged|current|correct|accurate))\b/i;
const VERDICT = /\b(unchanged|no change|not changed|same as (?:before|then)|hasn'?t changed|has not changed|haven'?t changed|have not changed|didn'?t change|did not change|stayed the same|still costs?|still priced|still (?:lists?|shows?|states?|charges?|at)|remains? (?:at|accurate|correct|valid|current|the same)|(?:is|are) still (?:accurate|correct|valid|current))\b/i;
// Not a bare "then": in pricing text it usually means "after that" ("$50 for 5 users, then $10/user").
// Live regression: that HubSpot row was removed as an "earlier value". "back then" / "then:" still count.
const PAST_BEFORE = /\b(was|were|previously|earlier|used to(?: be)?|had been|back then|then:|we said|i said|we quoted|i quoted|you were told|i told you|our earlier answer|my earlier answer)\b[^.;:|]{0,40}$|\bthen:\s*$/i;
// "Increased from $0.106", "Same as $25", "down from $9": the money is the earlier value.
const CHANGE_FROM = /\b(?:(?:up|down|increased|decreased|rose|risen|dropped|fell|fallen|changed|raised|cut|lowered|reduced|went up|went down|moved)\s+from|same as|unchanged (?:at|from)|identical to)\s*$/i;
const PAST_AFTER = /^[^.;|]{0,30}\b(before|previously|earlier|back then|at the time|on (?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)\b/i;
// "$0.106 (3 Nov)", "$25 (on Tue 3 Nov 2026)": a date in brackets right after the value.
const DATED_AFTER = /^\s*(?:\/\s*[\w-]+\s*)?\(\s*(?:on\s+|as of\s+)?([^)]{3,30})\)/i;

export interface NarrativeGuard {
  text: string;
  removed: string[];
}

const splitRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');

function mentions(entity: string, s: string): boolean {
  if (entityMentioned(entity, s)) return true;
  const toks = new Set(sectionTokens(s));
  return entityNeed(entity).some((t) => t.length >= 4 && !/^\d/.test(t) && toks.has(t));
}

/**
 * @param comp       the code comparison shown above the reply (null: nothing could be compared)
 * @param recorded   the recalled answer assertions: the only legitimate source of earlier values
 */
export interface GuardOptions {
  /**
   * Free-text path (a change question with no recalled conversation). A sentence may then state a
   * historical market fact if it cites a DATED source: a past value needs a source published on or
   * before the anchor that states it; an "unchanged" verdict needs a dated source from on/after the
   * anchor. Undated pages fetched today establish neither. Then/Now tables are left to thenCheck.
   */
  market?: { evidence: Evidence[]; anchor: string; today?: string };
}

/** Is the text in brackets after a value a date before today ("(3 Nov)")? */
function pastDate(text: string, today: string | undefined): boolean {
  if (!today) return false;
  const m = DATED_AFTER.exec(text);
  if (!m) return false;
  const d = explicitDate(m[1], new Date(`${today}T12:00:00Z`));
  return !!d && d < today;
}

export function guardNarrative(text: string, comp: Comparison | null, recorded: ClaimRow[], opts: GuardOptions = {}): NarrativeGuard {
  const removed: string[] = [];
  const byId = new Map((opts.market?.evidence ?? []).map((e) => [e.id, e]));
  const citedIn = (s: string) => [...s.matchAll(/\[(S\d+)\]/g)].map((m) => byId.get(m[1])).filter((e): e is Evidence => !!e);
  const anchor = opts.market?.anchor ?? '';
  const rows = comp?.rows ?? [];
  const allUnchanged = rows.length > 0 && rows.every((r) => r.status === 'unchanged') && !(comp?.facts.length ?? 0);
  const entities = [...new Set([...rows.map((r) => r.entity), ...recorded.map((c) => c.entity)])];
  const rowsFor = (s: string, section = '') => {
    let named = entities.filter((e) => mentions(e, s));
    // A row like "| Compute | … |" under "**Neon (Launch plan)**" is about Neon.
    if (!named.length && section) named = entities.filter((e) => mentions(e, section));
    return { named, rows: rows.filter((r) => named.includes(r.entity)) };
  };
  // Free-text path only: "Supabase Pro still costs $25" is fine when $25 is what we recorded for it.
  const recordedSupports = (plain: string, named: string[]): boolean => {
    if (comp || !named.length) return false;
    if (!named.every((e) => recorded.some((c) => c.entity === e))) return false;
    // A bare "X is unchanged" names no value to hold against the record (and may name items we never
    // recorded, like "Supabase and AWS RDS remain unchanged"): only "still $25" with a recorded $25 passes.
    const monies = [...plain.matchAll(MONEY)].map((m) => m[0]);
    return monies.length > 0 && monies.every((v) => recorded.some((c) => named.includes(c.entity) && valueAppearsIn(v, c.value)));
  };

  const keepSentence = (s: string, section = ''): boolean => {
    const plain = cleanText(s);
    if (!plain) return true;
    const cited = citedIn(s);
    const datedAfterAnchor = cited.some((e) => e.publishedAt && e.publishedAt >= anchor);
    const { named, rows: mine } = rowsFor(plain, section);
    if (BLANKET.test(plain) && !(named.length && mine.length && mine.every((r) => r.status === 'unchanged')) && !allUnchanged && !datedAfterAnchor) return false;
    if (VERDICT.test(plain) && !datedAfterAnchor && !recordedSupports(plain, named)) {
      if (named.length ? !(mine.length && mine.every((r) => r.status === 'unchanged')) : !allUnchanged) return false;
    }
    for (const m of plain.matchAll(MONEY)) {
      const before = plain.slice(0, m.index);
      const after = plain.slice(m.index! + m[0].length);
      if (!PAST_BEFORE.test(before) && !CHANGE_FROM.test(before) && !PAST_AFTER.test(after) && !pastDate(after, opts.market?.today)) continue;
      const recordedValue = recorded.some((c) => named.includes(c.entity) && valueAppearsIn(m[0], c.value));
      const historical = cited.some((e) => e.publishedAt && e.publishedAt <= anchor && valueAppearsIn(m[0], `${e.title}\n${e.excerpt}`));
      if (!recordedValue && !historical) return false;
    }
    return true;
  };

  const lines = text.split('\n');
  const out: string[] = [];
  let section = ''; // the latest heading / bold title line: names the product a table is about
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^\s*(?:#{1,4}\s+(.+)|\*\*([^*]+)\*\*\s*:?\s*)$/.exec(line);
    if (heading) section = cleanText(heading[1] ?? heading[2]);
    // A Then/Now style table written by the model: dropped, the code table above is authoritative.
    if (line.trim().startsWith('|') && lines[i + 1] && SEP.test(lines[i + 1])) {
      const header = splitRow(line).map(cleanText);
      const thenCol = header.findIndex((h) => THEN_COL.test(h) && !/\bnow\b|\btoday\b/i.test(h));
      const isReport = thenCol >= 0 && header.some((h, k) => k !== thenCol && NOW_COL.test(h));
      let end = i + 2;
      while (end < lines.length && lines[end].trim().startsWith('|')) end++;
      if (isReport && opts.market) {
        // Free-text path: checkThenValues already sanitised this table cell by cell.
        out.push(...lines.slice(i, end));
        i = end - 1;
        continue;
      }
      if (isReport) {
        removed.push(`table: ${header.join(' | ')}`);
        i = end - 1;
        continue;
      }
      // Ordinary table: check each row like a sentence.
      out.push(line, lines[i + 1]);
      for (let j = i + 2; j < end; j++) {
        if (keepSentence(lines[j], section)) out.push(lines[j]);
        else removed.push(cleanText(lines[j]));
      }
      i = end - 1;
      continue;
    }
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    const prefix = /^(\s*(?:[-*>]|\d+[.)])\s+)/.exec(line)?.[1] ?? '';
    const body = line.slice(prefix.length);
    const parts = body.split(/(?<=[.!?])\s+(?=[A-Z*"“(])/);
    const kept = parts.filter((p) => {
      const ok = keepSentence(p, section);
      if (!ok) removed.push(cleanText(p));
      return ok;
    });
    // Don't leave a fragment ("**Supported** [S7].") after removing the sentence it belonged to.
    const rest = cleanText(kept.join(' ')).replace(/[*_]/g, '').trim();
    if (kept.length === parts.length || rest.length >= 25) {
      if (kept.length) out.push(prefix + kept.join(' '));
    } else if (kept.length) removed.push(rest);
  }
  let result = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (removed.length)
    result += `${result ? '\n\n' : ''}> ℹ️ Removed ${removed.length} statement${removed.length > 1 ? 's' : ''} about earlier values or an overall verdict that ${comp ? 'the recorded comparison above does not support' : 'neither our records nor a dated source supports'}.`;
  return { text: result, removed };
}
