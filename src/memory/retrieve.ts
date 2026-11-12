// Memory retrieval (sync, in code, ≈ms): time-window filter first, then keyword ranking,
// then a compact <memory> block. Abstention ("no conversation on that date") is explicit.
//
// The ACTIVE conversation is searched too: a user who asks "what did I ask on Monday?" in Monday's
// chat, after more than the recent-history window of messages, must still get Monday's turn.
// Overlap with the recent history already in the prompt is handled by message ID.

import { config } from '../config.js';
import type { Route } from '../agent/router.js';
import type { DateWindow } from '../time/resolve.js';
import { diffDays, parseIsoDate, prettyDate, prettyInstant } from '../time/tz.js';
import { buildRecheckPlan, type RecheckPlan } from '../verify/reverify.js';
import { type ClaimRow, type MessageRow, claimsForMessages, entitySetsForMessages, getDb, hasFts, isBaseline } from './db.js';
import { joinValue, parseQualifiers } from '../verify/diff.js';
import { entityMentioned } from '../verify/support.js';

export interface RecalledTurn {
  conversationId: string;
  conversationTitle: string;
  user: MessageRow;
  assistant: MessageRow | null;
  score: number;
  /** Already in the prompt as recent history (rendered compactly). */
  inHistory: boolean;
  sameConversation: boolean;
}

export interface Absence {
  phrase: string;
  labels: string[];
  nearest: string[]; // YYYY-MM-DD
  firstConversation: boolean;
}

export interface MemoryResult {
  block: string; // '' when memory is irrelevant to this turn
  turns: RecalledTurn[];
  /** Every stored assertion of the recalled turns (prices, facts, events; any status). */
  claims: ClaimRow[];
  /** Price assertions usable as comparison baselines. */
  baselines: ClaimRow[];
  /** Non-price statements from the recalled answers. */
  facts: ClaimRow[];
  /** Items the user named that have no stored value. */
  unvalued: string[];
  /** Products in play for this turn (recalled items). */
  entities: string[];
  constraints: Record<string, string>;
  anchorDate: string | null; // YYYY-MM-DD: "since" date for re-verification
  usedWindows: DateWindow[];
  abstained: boolean;
  absences: Absence[];
  /** Two candidate dates are equally plausible: both are recalled and the user should be asked. */
  ambiguous: { phrase: string; options: string[] } | null;
  recheck: RecheckPlan | null;
  notes: string[];
  /** For a pure recall request with nothing found: the answer, produced from retrieval directly. */
  directAnswer: string | null;
  /** The user is asking a question they already asked: the earlier turn. */
  repeatOf: RecalledTurn | null;
}

const STOP = new Set(
  `the and for are was were you your our we i me my what which who how did does do has have had any anything since then
  that this there their them they with from about into over still correct today now ago last on in at of to a an is it its
  be been being can could would should will just also some more most very really please tell show asked ask said say told
  changed change changes chang shortlisted shortlist discussed talked compare compared mentioned answer answers question
  monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september
  october november december jan feb mar apr jun jul aug sep sept oct nov dec week month year yesterday day days time
  them those these when where why than then up out new latest current currently shipped something big remind remember`.split(/\s+/),
);

export function keywords(text: string): string[] {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/);
  return [...new Set(words.filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
}

function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, '');
}

function score(text: string, kws: string[]): number {
  if (!kws.length) return 0;
  const hay = text.toLowerCase();
  return kws.reduce((acc, k) => acc + (hay.includes(stem(k)) ? 1 : 0), 0);
}

function pairTurn(m: MessageRow): { user: MessageRow; assistant: MessageRow | null } | null {
  const db = getDb();
  if (m.role === 'user') {
    const a = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND id > ? AND role = 'assistant' ORDER BY id LIMIT 1").get(m.conversation_id, m.id) as MessageRow | undefined;
    return { user: m, assistant: a ?? null };
  }
  const u = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND id < ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(m.conversation_id, m.id) as MessageRow | undefined;
  return u ? { user: u, assistant: m } : null;
}

function titleOf(conversationId: string): string {
  return ((getDb().prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title?: string }) ?? {}).title ?? '';
}

interface Ctx {
  conversationId: string;
  historyIds: Set<number>;
}

function recalled(p: { user: MessageRow; assistant: MessageRow | null }, s: number, ctx: Ctx): RecalledTurn {
  return {
    conversationId: p.user.conversation_id,
    conversationTitle: titleOf(p.user.conversation_id),
    user: p.user,
    assistant: p.assistant,
    score: s,
    inHistory: ctx.historyIds.has(p.user.id),
    sameConversation: p.user.conversation_id === ctx.conversationId,
  };
}

function turnsInWindow(w: DateWindow, kws: string[], ctx: Ctx): RecalledTurn[] {
  const rows = getDb().prepare("SELECT * FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ? ORDER BY created_at, id").all(w.start, w.end) as unknown as MessageRow[];
  return rows.map((u) => {
    const p = pairTurn(u)!;
    const entityText = claimsForMessages(p.assistant ? [p.assistant.id] : []).map((c) => c.entity).join(' ');
    return recalled(p, score(`${u.content} ${p.assistant?.content ?? ''} ${entityText}`, kws), ctx);
  });
}

function keywordSearch(kws: string[], ctx: Ctx, limit = 3): RecalledTurn[] {
  if (!kws.length) return [];
  const db = getDb();
  let rows: MessageRow[] = [];
  if (hasFts) {
    const q = kws.map((k) => `"${k.replace(/"/g, '')}"*`).join(' OR ');
    rows = db.prepare(`SELECT m.* FROM fts_messages f JOIN messages m ON m.id = f.rowid WHERE fts_messages MATCH ? ORDER BY bm25(fts_messages) LIMIT 20`).all(q) as unknown as MessageRow[];
  } else {
    const like = kws.map(() => 'content LIKE ?').join(' OR ');
    rows = db.prepare(`SELECT * FROM messages WHERE (${like}) ORDER BY created_at DESC LIMIT 20`).all(...kws.map((k) => `%${k}%`)) as unknown as MessageRow[];
  }
  const seen = new Set<number>();
  const out: RecalledTurn[] = [];
  for (const r of rows) {
    const p = pairTurn(r);
    if (!p || seen.has(p.user.id)) continue;
    seen.add(p.user.id);
    const s = score(`${p.user.content} ${p.assistant?.content ?? ''}`, kws);
    // Require the user's own question to share a topic word: avoids recalling a turn that merely mentions it.
    if (score(p.user.content + ' ' + (p.assistant?.content.slice(0, 400) ?? ''), kws) === 0) continue;
    out.push(recalled(p, s, ctx));
  }
  return out.sort((a, b) => b.score - a.score || b.user.created_at.localeCompare(a.user.created_at)).slice(0, limit);
}

/** "Has any of them changed?" in the same chat: the latest earlier turn here that recorded items or values. */
function latestTurnWithItems(ctx: Ctx): RecalledTurn[] {
  const rows = getDb()
    .prepare(
      `SELECT m.* FROM messages m WHERE m.conversation_id = ? AND m.role = 'assistant'
         AND (EXISTS (SELECT 1 FROM claims c WHERE c.message_id = m.id) OR EXISTS (SELECT 1 FROM entity_sets s WHERE s.message_id = m.id))
       ORDER BY m.id DESC LIMIT 1`,
    )
    .all(ctx.conversationId) as unknown as MessageRow[];
  return rows.map((a) => pairTurn(a)).filter((p): p is NonNullable<typeof p> => !!p).map((p) => recalled(p, 0, ctx));
}

function nearestDates(around: string, n = 3): string[] {
  const rows = getDb().prepare("SELECT DISTINCT local_date FROM messages WHERE role = 'user'").all() as { local_date: string }[];
  const target = parseIsoDate(around);
  return rows
    .map((r) => r.local_date)
    .sort((a, b) => Math.abs(diffDays(parseIsoDate(a), target)) - Math.abs(diffDays(parseIsoDate(b), target)))
    .slice(0, n)
    .sort();
}

const stripCitations = (s: string) => s.replace(/\s?\[S\d+\]/g, '');
const pretty = (d: string) => prettyDate(parseIsoDate(d));
const MAX_TURNS_PER_DAY = 4;

function directAnswerFor(absences: Absence[], kwAbsence: string[] | null, firstEver: boolean): string {
  if (firstEver) return "I don't have any earlier conversations with you stored, so there's nothing to recall yet: this appears to be our first conversation.";
  if (kwAbsence) return `I couldn't find an earlier conversation about ${kwAbsence.join(', ') || 'that'}. If you tell me roughly when it was, I'll look on that day.`;
  return absences
    .map((a) => {
      const near = a.nearest.length ? ` The nearest days with conversations are ${a.nearest.map(pretty).join(', ')}; tell me if you meant one of those and I'll pull it up.` : '';
      return `I don't have any conversation with you on ${a.labels.join(' or ')} ("${a.phrase}"), so I can't tell you what you asked then.${near}`;
    })
    .join('\n\n');
}

export function retrieveMemory(opts: { message: string; windows: DateWindow[]; route: Route; conversationId: string; tz: string; historyIds?: Set<number> }): MemoryResult {
  const { message, windows, route, conversationId, tz } = opts;
  const ctx: Ctx = { conversationId, historyIds: opts.historyIds ?? new Set() };
  const kws = keywords(message);
  const notes: string[] = [];
  const absences: Absence[] = [];
  let turns: RecalledTurn[] = [];
  const usedWindows: DateWindow[] = [];
  let abstained = false;
  let ambiguous: MemoryResult['ambiguous'] = null;
  let kwAbsence: string[] | null = null;
  let repeatOf: RecalledTurn | null = null;

  const empty: MemoryResult = {
    block: '', turns: [], claims: [], baselines: [], facts: [], unvalued: [], entities: [], constraints: {}, anchorDate: null,
    usedWindows: [], abstained: false, absences: [], ambiguous: null, recheck: null, notes, directAnswer: null, repeatOf: null,
  };
  const totalMessages = () => (getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;

  const select = (c: { w: DateWindow; turns: RecalledTurn[] }): RecalledTurn[] => {
    const topical = c.turns.filter((t) => t.score > 0);
    if (kws.length && !topical.length && route.memoryIntent && /\babout\b/i.test(message)) {
      notes.push(`Conversations exist on ${c.w.label}, but none mention: ${kws.join(', ')}. Listing what was discussed that day.`);
    }
    const picked = topical.length ? [...topical].sort((a, b) => b.score - a.score) : c.turns;
    if (picked.length > MAX_TURNS_PER_DAY) {
      const rest = picked.slice(MAX_TURNS_PER_DAY);
      notes.push(
        `${c.w.label} has ${picked.length} ${topical.length ? 'matching ' : ''}turns; only ${MAX_TURNS_PER_DAY} fit here. Not shown (questions only): ${rest
          .slice(0, 8)
          .map((t) => `"${t.user.content.replace(/\s+/g, ' ').slice(0, 70)}"`)
          .join('; ')}${rest.length > 8 ? `; +${rest.length - 8} more` : ''}. If the user asked for everything from that day, say this list is partial.`,
      );
    }
    return picked.slice(0, MAX_TURNS_PER_DAY);
  };

  if (windows.length && (route.memoryIntent || route.changeIntent)) {
    const groups = [...new Set(windows.map((w) => w.group))];
    for (const g of groups) {
      const cands = windows.filter((w) => w.group === g).map((w) => ({ w, turns: turnsInWindow(w, kws, ctx) }));
      const best = (c: (typeof cands)[number]) => Math.max(0, ...c.turns.map((t) => t.score));
      let withTurns = cands.filter((c) => c.turns.length);
      // A date question about the world ("what changed in Next.js since Monday?") is not a memory
      // request: use a window only if it holds a conversation on this topic, and never abstain.
      if (!route.memoryIntent) withTurns = withTurns.filter((c) => best(c) > 0);
      if (!withTurns.length) {
        if (!route.memoryIntent) continue;
        const near = nearestDates(cands[0].w.from);
        const first = totalMessages() === 0;
        absences.push({ phrase: cands[0].w.phrase, labels: cands.map((c) => c.w.label), nearest: near, firstConversation: first });
        notes.push(
          `No conversations found for "${cands[0].w.phrase}" (${cands.map((c) => c.w.label).join(' or ')}). ` +
            (near.length ? `Nearest dates with conversations: ${near.map(pretty).join(', ')}.` : 'There are no stored past conversations at all: this appears to be our first conversation.'),
        );
        abstained = true;
        continue;
      }
      // Ambiguity is settled by data when one candidate matches the topic better; otherwise both are shown.
      withTurns.sort((a, b) => best(b) - best(a) || b.w.confidence - a.w.confidence);
      const chosen = withTurns[0];
      const rival = withTurns[1];
      if (rival && best(rival) === best(chosen)) {
        usedWindows.push(chosen.w, rival.w);
        ambiguous = { phrase: chosen.w.phrase, options: [chosen.w.label, rival.w.label] };
        notes.push(
          `"${chosen.w.phrase}" is ambiguous: it could mean ${chosen.w.label} or ${rival.w.label}, and both have conversations${best(chosen) ? ' about this topic' : ''}. ` +
            'Both are listed below (Other candidate included). Do not pick one as certain: say what was discussed on each date, then ask the user one short question to confirm which day they meant.',
        );
        turns.push(...select(chosen), ...select(rival));
      } else {
        usedWindows.push(chosen.w);
        if (cands.length > 1) {
          const others = cands
            .filter((c) => c !== chosen)
            .map((c) => `${c.w.label} (${c.turns.length ? (best(c) ? 'also has a matching conversation' : 'has conversations, none on this topic') : 'no conversations'})`);
          notes.push(`"${chosen.w.phrase}" is ambiguous; using ${chosen.w.label}${best(chosen) ? ' because its conversation matches the topic' : ''}. Other candidate: ${others.join('; ')}. Mention this in one short clause.`);
        }
        turns.push(...select(chosen));
      }
    }
  } else if (route.memoryIntent || route.changeIntent) {
    turns = keywordSearch(kws, ctx);
    // "Has any of them changed since?" right here in the same chat: the items named earlier in it.
    if (!turns.length && route.changeIntent) turns = latestTurnWithItems(ctx);
    if (!turns.length && route.memoryIntent) {
      const total = totalMessages();
      notes.push(total ? `No earlier conversation matches: ${kws.join(', ') || '(no topic words)'}.` : 'There are no stored past conversations at all: this appears to be our first conversation.');
      kwAbsence = kws;
      abstained = true;
    }
  } else {
    // The same question asked again (in this chat or an earlier one): recall what we answered, so
    // the new answer can't silently contradict it. Live regression: "Shortlist 3 CRMs" asked twice
    // a minute apart gave HubSpot Starter $7, then $45, with no word about the difference.
    const rep = repeatedQuestion(kws, ctx);
    if (!rep) return empty;
    repeatOf = rep;
    turns = [rep];
    const when = prettyInstant(new Date(rep.user.created_at), rep.user.user_tz || tz);
    notes.push(
      `The user asked this same question before (${when}, ${rep.sameConversation ? 'earlier in this conversation' : `conversation "${rep.conversationTitle}"`}). ` +
        'What you answered then, with its stored values, is below. Start with one short clause saying you answered this before (give the date/time). ' +
        'Answer from today\'s sources. If a value you give now differs from what you said then, say so explicitly with both values and the likely reason ' +
        '(e.g. the earlier source was outdated, or a different plan). Never give different numbers silently.',
    );
  }

  // Dedupe (a turn can be in two windows' candidate lists), keep chronological order within the result.
  turns = turns.filter((t, i) => turns.findIndex((x) => x.user.id === t.user.id) === i);

  if (!turns.length && !notes.length) return empty;

  const assistantIds = turns.map((t) => t.assistant?.id).filter((x): x is number => !!x);
  const claims = claimsForMessages(assistantIds);
  const baselines = claims.filter(isBaseline);
  const facts = claims.filter((c) => c.kind === 'fact');
  const sets = entitySetsForMessages(assistantIds);
  const constraints: Record<string, string> = {};
  for (const s of sets) if (s.constraints_json) Object.assign(constraints, JSON.parse(s.constraints_json));
  const anchorDate = turns.length ? turns.map((t) => t.user.local_date).sort()[0] : null;
  // Items the user listed (or the answer laid out) that have no stored value: still worth re-checking.
  const members = [...new Set(sets.flatMap((s) => JSON.parse(s.members_json) as string[]))];
  const unvalued = members.filter((n) => !baselines.some((c) => c.entity.toLowerCase() === n.toLowerCase() || entityMentioned(n, c.entity)));
  const factEntities = [...new Set(facts.map((f) => f.entity))].filter((e) => !baselines.some((c) => c.entity === e) && !unvalued.includes(e));
  const entities = [...new Set([...baselines.map((c) => c.entity), ...unvalued, ...factEntities])];
  // Re-check against the earlier answer's own sources: for "has it changed?", and for the same question
  // asked again when the earlier answer stated prices (then vs now, from the same websites).
  const recheck =
    route.changeIntent && anchorDate && (baselines.length || unvalued.length || facts.length)
      ? buildRecheckPlan(baselines, anchorDate, unvalued, factEntities)
      : repeatOf && anchorDate && baselines.length
        ? buildRecheckPlan(baselines, anchorDate)
        : null;
  if (route.changeIntent && turns.length) {
    if (!baselines.length) {
      notes.push(
        `No values were stored from ${turns.map((t) => t.user.local_date).join(', ')}, so there is nothing to compare against. ` +
          'Do NOT say anything is unchanged or changed, and do NOT write a Then column or reconstruct what was said: say plainly that no earlier values were recorded, then give today\'s values.',
      );
    } else if (unvalued.length) {
      notes.push(`No value was stored for: ${unvalued.join(', ')}. For these, give today's value only; the system shows them as "not recorded".`);
    }
  }

  // ---- render, within a char budget ----
  const budget = config.budgets.memoryChars;
  const answerBudget = Math.max(300, Math.floor((budget - 1500) / Math.max(1, turns.length)) - 200);
  const parts: string[] = [];
  for (const n of notes) parts.push(`NOTE: ${n}`);
  if (Object.keys(constraints).length) parts.push(`Constraints the user stated earlier: ${Object.entries(constraints).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('; ')}`);
  turns.forEach((t, i) => {
    const when = prettyInstant(new Date(t.user.created_at), t.user.user_tz || tz);
    const where = t.sameConversation ? 'this conversation' : `conversation "${t.conversationTitle}"`;
    const lines = [`Past turn ${i + 1}: ${when} (${t.user.user_tz}), ${where}${t.inHistory ? ' [also in the recent messages above]' : ''}`, `  User asked: "${t.user.content.slice(0, 400)}"`];
    if (t.assistant?.failed) {
      lines.push('  (No answer was given at the time: generation failed. Nothing was stated then, so there are NO earlier values.)');
      for (const s of sets.filter((x) => x.message_id === t.assistant!.id)) lines.push(`  Items the user named: ${(JSON.parse(s.members_json) as string[]).join(', ')}`);
    } else if (t.assistant) {
      if (!t.inHistory) {
        const ans = stripCitations(t.assistant.content).replace(/\n{2,}/g, '\n');
        lines.push(`  You answered: """${ans.length > answerBudget ? ans.slice(0, answerBudget) + ' …[truncated]' : ans}"""`);
      }
      for (const s of sets.filter((x) => x.message_id === t.assistant!.id && (JSON.parse(x.members_json) as string[]).length))
        lines.push(`  Entity set "${s.label}": ${(JSON.parse(s.members_json) as string[]).join(', ')}`);
      const mine = claims.filter((c) => c.message_id === t.assistant!.id);
      const prices = mine.filter(isBaseline).slice(0, 25);
      if (prices.length) {
        lines.push('  Stored claims (what you said then, linked to evidence):');
        for (const c of prices) {
          const q = parseQualifiers(c.qualifiers_json);
          const terms = Object.entries(q).map(([k, v]) => `${k} ${v}`).join(', ');
          lines.push(
            `   - ${c.entity}${c.plan ? ` [${c.plan}]` : ''} ${c.attribute} = ${joinValue(c)} (as of ${c.as_of}${c.source_url ? `, source ${c.source_url}, ${c.source_tier}` : ''}${terms ? `, terms: ${terms}` : ''}${c.status === 'estimate' ? ', ESTIMATE' : ''})${c.demo ? ' **DEMO DATA: deliberately altered, not a real past value**' : ''}`,
          );
        }
      }
      const unsupported = mine.filter((c) => (c.kind ?? 'price') === 'price' && c.status === 'unsupported').slice(0, 10);
      if (unsupported.length) lines.push(`  Prices stated without a verified source (not a baseline): ${unsupported.map((c) => `${c.entity} ${joinValue(c)}`).join('; ')}`);
      const fs = mine.filter((c) => c.kind === 'fact').slice(0, 8);
      if (fs.length) lines.push(`  Non-price statements made: ${fs.map((c) => `${c.entity}: "${c.value}"${c.status === 'uncited' ? ' (uncited)' : ''}`).join('; ')}`);
      const evs = mine.filter((c) => c.kind === 'event').slice(0, 5);
      if (evs.length) lines.push(`  Announcements mentioned: ${evs.map((c) => `${c.entity}: ${c.value}`).join('; ')}`);
    } else lines.push('  (no answer was stored for this turn)');
    parts.push(lines.join('\n'));
  });
  if (recheck) {
    parts.push(
      `RE-CHECK DONE: the system already ran web_search since="${recheck.since}" for ${JSON.stringify(recheck.queries.slice(0, 6))} ` +
        '(current sources + news since that date); the code-computed <comparison> is in the web_search result and is ALREADY SHOWN to the user above your reply. Search again only for a specific fact still missing.',
    );
  }
  let block = parts.join('\n\n');
  if (block.length > budget) block = block.slice(0, budget) + '\n…[memory truncated]';

  const firstEver = abstained && totalMessages() === 0;
  const directAnswer = route.pureRecall && abstained && !turns.length ? directAnswerFor(absences, kwAbsence, firstEver) : null;

  return { block, turns, claims, baselines, facts, unvalued, entities, constraints, anchorDate, usedWindows, abstained, absences, ambiguous, recheck, notes, directAnswer, repeatOf };
}

/** An earlier, answered turn asking (nearly) the same thing: ≥ 75% keyword overlap, ≥ 2 keywords. */
function repeatedQuestion(kws: string[], ctx: Ctx): RecalledTurn | null {
  if (kws.length < 2) return null;
  const mine = new Set(kws.map(stem));
  for (const t of keywordSearch(kws, ctx, 5)) {
    if (!t.assistant || t.assistant.failed) continue;
    const theirs = new Set(keywords(t.user.content).map(stem));
    const inter = [...mine].filter((k) => theirs.has(k)).length;
    const union = new Set([...mine, ...theirs]).size;
    if (union && inter / union >= 0.75) return t;
  }
  return null;
}
