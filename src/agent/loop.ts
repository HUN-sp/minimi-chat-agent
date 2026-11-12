// One chat turn, end to end, under ONE deadline:
//   resolve dates → route → retrieve memory (incl. this conversation)
//   → [pure recall with nothing found: answer directly from retrieval, no model call]
//   → [re-check: prefetch searches + code comparison; the validated comparison streams first]
//   → streaming tool loop (bounded rounds, searches only while time remains)
//   → guard the model's text against the comparison → validate citations
//   → persist the turn, its sources and its answer-linked memory → final event.
// When the deadline hits, in-flight requests are aborted and the turn ends with what is validated.

import { randomUUID } from 'node:crypto';
import type { ChatCompletionMessageFunctionToolCall as ChatCompletionMessageToolCall, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { autoCite } from '../answer/autocite.js';
import { enforceLabels } from '../answer/labels.js';
import { inconsistencies } from '../answer/consistency.js';
import { stalePrices } from '../answer/freshness.js';
import { checkCitedValues, checkGrounding } from '../answer/grounding.js';
import { validateCitations } from '../answer/citations.js';
import { guardNarrative } from '../answer/narrative.js';
import { checkThenValues } from '../answer/thenCheck.js';
import { config, defaultTz, getNow } from '../config.js';
import { type CallBudget, type FallbackEvent, streamChat } from '../llm/client.js';
import { checkAnswerClaims, recordTurnMemory } from '../memory/assertions.js';
import { claimsForMessages, getConversation, getMessages, insertMessage, insertSource, linkSource, setMemoryStatus, upsertConversation } from '../memory/db.js';
import { parseNameList } from '../memory/parseClaims.js';
import { retrieveMemory } from '../memory/retrieve.js';
import { EvidenceRegistry } from '../search/postprocess.js';
import { WEB_SEARCH_TOOL, executeWebSearch, type SearchContext } from '../search/tool.js';
import { resolveDates } from '../time/resolve.js';
import { civilDateIn, isValidTz, isoDate, prettyInstant } from '../time/tz.js';
import { joinValue } from '../verify/diff.js';
import { counts, renderComparisonForUser } from '../verify/reverify.js';
import { resolveClarification } from './clarify.js';
import { Deadline, DeadlineError, isAbortError, newTelemetry } from './deadline.js';
import { SYSTEM_PROMPT, contextBlock } from './prompt.js';
import { route } from './router.js';

export type TurnEvent =
  | { type: 'meta'; conversationId: string }
  | { type: 'status'; text: string }
  | { type: 'token'; text: string }
  | { type: 'reset' } // discard streamed draft (model wrote a preface, then searched)
  | { type: 'final'; text: string; sources: PublicSource[]; messageId: number; conversationId: string }
  | { type: 'debug'; data: unknown }
  | { type: 'error'; message: string };

export interface PublicSource {
  id: string;
  url: string;
  domain: string;
  title: string;
  tier: string;
  publishedAt: string | null;
  retrievedAt: string;
  cited: boolean;
}

export interface TurnOptions {
  message: string;
  conversationId?: string;
  tz?: string;
  now?: Date;
  emit?: (e: TurnEvent) => void;
  /** Override the turn deadline (tests). */
  deadlineMs?: number;
}

export interface TurnResult {
  conversationId: string;
  messageId: number;
  answer: string;
  /** Answer-linked memory is written before the final event; this resolves to its summary. */
  extraction: Promise<unknown>;
  debug: Record<string, any>;
}

const stripCitations = (s: string) => s.replace(/\s?\[S\d+\]/g, '');

const cleanLength = (s: string) => s.replace(/[|*_>-]/g, '').replace(/\s+/g, ' ').trim().length;

/** Prices, versions, news, shortlists: answers that go stale, so they must come from a search. */
const TIME_SENSITIVE =
  /\b(prices?|pricing|costs?|how much|per (?:user|seat|month)|subscription|fees?|latest|newest|current(?:ly)?|news|releases?|released|versions?|shortlist|short-list|compare|comparison|versus|vs\.?|alternatives?|launch(?:ed|es)?|announc(?:ed|ement|ements)?|this (?:week|month|year))\b/i;
function needsSearch(message: string, r: { smallTalk: boolean; pureRecall: boolean }): boolean {
  return !r.smallTalk && !r.pureRecall && TIME_SENSITIVE.test(message);
}
const TOOL_TOKENS = Math.ceil(JSON.stringify(WEB_SEARCH_TOOL).length / 3);

export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  const deadline = new Deadline(opts.deadlineMs ?? config.budgets.turnMs);
  try {
    return await turn(opts, deadline);
  } finally {
    deadline.dispose();
  }
}

async function turn(opts: TurnOptions, deadline: Deadline): Promise<TurnResult> {
  const t0 = Date.now();
  const emit = opts.emit ?? (() => {});
  const now = opts.now ?? getNow();
  const tz = isValidTz(opts.tz) ? opts.tz : defaultTz();
  const today = isoDate(civilDateIn(now, tz));
  const message = opts.message.trim().slice(0, 4000);
  const conversationId = opts.conversationId && getConversation(opts.conversationId) ? opts.conversationId : opts.conversationId?.match(/^[\w-]{6,64}$/) ? opts.conversationId : randomUUID();
  emit({ type: 'meta', conversationId });

  const B = config.budgets;
  const timings: Record<string, number> = {};
  const telemetry = newTelemetry();
  const fallbacks: FallbackEvent[] = [];
  const onFallback = (e: FallbackEvent) => {
    fallbacks.push(e);
    emit({ type: 'status', text: `${e.from}: ${e.reason}, switching model…` });
  };
  const useful = () => {
    timings.firstUsefulMs ??= Date.now() - t0;
  };

  // 1. Temporal resolver + routing (deterministic, ≈ms). A short reply to our own clarifying
  //    question ("3 Nov") is resolved against the pending question first, and the turn is then
  //    routed and recalled as that question ("What did I ask you on Tue 3 Nov 2026?").
  const history = getMessages(conversationId).slice(-B.historyMessages);
  const clarification = resolveClarification(message, history, now, tz);
  const effective = clarification?.effective ?? message;
  const windows = resolveDates(effective, now, tz);
  const r = route(effective, windows.length > 0);
  timings.resolveMs = Date.now() - t0;

  // 2. Memory retrieval (in code, not a tool call). This conversation is searched too; the recent
  //    history already in the prompt is identified by message ID.
  const memory = retrieveMemory({ message: effective, windows, route: r, conversationId, tz, historyIds: new Set(history.map((m) => m.id)) });
  timings.retrieveMs = Date.now() - t0 - timings.resolveMs;
  if (memory.turns.length || memory.abstained) {
    const where = memory.usedWindows.length ? memory.usedWindows.map((w) => w.label).join(' and ') : 'past conversations';
    emit({ type: 'status', text: memory.turns.length ? `Recalled ${memory.turns.length} past turn${memory.turns.length > 1 ? 's' : ''} from ${where}` : `No matching past conversation found (${windows.map((w) => w.label).join(' / ') || 'any date'})` });
  }
  emit({ type: 'debug', data: { stage: 'pre', windows, route: r, clarification, memoryBlock: memory.block, timings } });

  const nowIso = now.toISOString();
  const entities = [...new Set([...memory.entities, ...parseNameList(effective)])];

  // Persist the turn. A failed turn keeps the user's question (so "what did I ask on …" still works)
  // and the items they named, but is flagged so it is never recalled as an answer.
  const persist = (text: string, meta: unknown, failedTurn: boolean): number => {
    upsertConversation(conversationId, message.replace(/\s+/g, ' ').slice(0, 70), nowIso, tz);
    insertMessage({ conversation_id: conversationId, role: 'user', content: message, created_at: nowIso, local_date: today, user_tz: tz, meta_json: null });
    return insertMessage({
      conversation_id: conversationId,
      role: 'assistant',
      content: text,
      created_at: new Date(now.getTime() + Math.max(1, Date.now() - t0)).toISOString(),
      local_date: today,
      user_tz: tz,
      meta_json: JSON.stringify(meta),
      failed: failedTurn,
      memory_status: 'pending',
    });
  };
  const remember = (messageId: number, answerText: string, factText: string | undefined, evidence: ReturnType<EvidenceRegistry['all']>, sourceIds: Map<string, number>) => {
    try {
      return recordTurnMemory({ messageId, userText: effective, answerText, factText, evidence, sourceIds, asOf: today, entities });
    } catch (e) {
      console.warn(`[memory] could not record message ${messageId}: ${(e as Error).message}`);
      setMemoryStatus(messageId, 'failed');
      return null;
    }
  };

  // 2b. A pure recall request ("what did I ask on 1 Nov?") with nothing stored: the absence statement
  //     comes straight from retrieval. No model call can turn it into an invented conversation.
  if (memory.directAnswer) {
    timings.totalMs = Date.now() - t0;
    timings.firstUsefulMs = timings.totalMs;
    const debug = { timings, telemetry, model: 'none (answered from memory retrieval)', rounds: [], fallbacks, windows, route: r, clarification, memory: debugMemory(memory), searches: [], credits: 0, diff: [], failed: false, direct: true };
    const messageId = persist(memory.directAnswer, debug, false);
    const record = remember(messageId, memory.directAnswer, undefined, [], new Map());
    emit({ type: 'final', text: memory.directAnswer, sources: [], messageId, conversationId });
    emit({ type: 'debug', data: { stage: 'final', ...debug } });
    return { conversationId, messageId, answer: memory.directAnswer, extraction: Promise.resolve(record), debug };
  }

  // 3. Agent loop
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: contextBlock({ now, tz, windows, memoryBlock: memory.block }) },
    ...history.map(
      (m) => ({ role: m.role, content: m.failed ? '(No answer was produced for this message: generation failed.)' : stripCitations(m.content).slice(0, 3000) }) as ChatCompletionMessageParam,
    ),
    ...(clarification
      ? [
          {
            role: 'system',
            content: `The user's next message answers your clarifying question: they mean ${clarification.label}. Answer their earlier question for that date only, as if they had asked: "${clarification.effective}". Use <memory> for what was said then; do not re-check prices unless that question asked for it.`,
          } as ChatCompletionMessageParam,
        ]
      : []),
    { role: 'user', content: message },
  ];

  const registry = new EvidenceRegistry();
  // Searching and extraction stop `answerReserveMs` before the deadline so the answer can be written.
  const searchSignal = deadline.phaseSignal(B.answerReserveMs);
  const extractionBudget: CallBudget = { signal: searchSignal, remainingMs: () => deadline.remaining() - B.answerReserveMs, telemetry, onFallback };
  const answerBudget: CallBudget = { signal: deadline.signal, remainingMs: () => deadline.remaining(), telemetry, onFallback };
  const ctx: SearchContext = {
    registry,
    today,
    nowIso,
    now,
    memoryClaims: memory.baselines,
    unvalued: memory.unvalued,
    facts: memory.facts,
    entities,
    launchIntent: r.launchIntent,
    queriesUsed: 0,
    printed: new Map(),
    logs: [],
    comparison: null,
    status: (text) => emit({ type: 'status', text }),
    onFallback,
    signal: searchSignal,
    budget: extractionBudget,
    allowModel: () => deadline.remaining() > B.answerReserveMs + 3000,
    telemetry,
  };

  // Code-rendered, validated content shown above the model's reply (the re-check comparison).
  let prefix = '';
  const emitModel = (e: TurnEvent) => {
    emit(e);
    if (e.type === 'reset' && prefix) emit({ type: 'token', text: `${prefix}\n\n` });
  };

  let answer = '';
  let model = '';
  let failed = false;
  let timedOut = false;
  let cutOff = false;
  const rounds: { ms: number; model: string; toolCalls: number }[] = [];

  try {
    // Re-check questions ("has any of them changed since Monday?"): the queries are known from memory,
    // so the searches and the code comparison run BEFORE the first model call. The comparison is
    // validated, then shown immediately; the model only writes what code can't.
    if (memory.recheck) {
      const tp = Date.now();
      const args = JSON.stringify({ queries: memory.recheck.queries, since: memory.recheck.since, domains: memory.recheck.domains });
      const out = await executeWebSearch(args, ctx);
      const id = 'call_recheck_prefetch';
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'web_search', arguments: args } }] });
      messages.push({ role: 'tool', tool_call_id: id, content: out });
      timings.prefetchMs = Date.now() - tp;
      if (ctx.comparison) {
        prefix = renderComparisonForUser(ctx.comparison);
        emit({ type: 'token', text: `${prefix}\n\n` });
        useful();
      }
    }

    const maxRounds = memory.recheck ? B.maxRoundsAfterPrefetch : B.maxRounds;
    for (let round = 0; ; round++) {
      // A new search round only if there is a round left AND time to search before the answer reserve.
      const canSearch = !r.smallTalk && round < maxRounds && ctx.queriesUsed < B.maxQueries && deadline.remaining() > B.answerReserveMs + B.minSearchMs;
      if (!canSearch && round > 0) {
        messages.push({ role: 'system', content: 'Search budget reached. Write the final answer now from the evidence above, and say clearly what you could not verify.' });
      }
      // A time-sensitive question (prices, "latest", a shortlist…) must not be answered from training
      // data: the first round is required to search. Live regression: "Shortlist 3 CRMs" was once
      // answered with no search at all, with invented "(hubspot.com, fetched 12 Nov 2026)" provenance.
      const mustSearch = round === 0 && canSearch && !memory.recheck && !ctx.queriesUsed && needsSearch(effective, r);
      const toolChoice = r.smallTalk ? undefined : mustSearch ? 'required' : canSearch ? 'auto' : 'none';
      const rt = Date.now();
      const onFirst = () => {
        timings.firstTokenMs ??= Date.now() - t0;
        useful();
      };
      let result: RoundResult;
      try {
        result = await streamRound(messages, toolChoice, emitModel, answerBudget, onFirst);
      } catch (err) {
        if (toolChoice === 'required' && !isAbortError(err)) {
          // The provider rejected the forced tool call (live: Groq 400 on gpt-oss): search in code below.
          result = { content: '', toolCalls: [], model, cutOff: false };
        } else {
          if (canSearch || toolChoice === undefined || isAbortError(err)) throw err;
          // Some providers reject tool history with tool_choice "none": retry with the evidence flattened.
          emitModel({ type: 'reset' });
          result = await streamRound(flatten(messages), undefined, emitModel, answerBudget, onFirst);
        }
      }
      model = result.model || model;
      rounds.push({ ms: Date.now() - rt, model, toolCalls: result.toolCalls.length });

      // A time-sensitive question must be answered from a search, whatever the model did with
      // "required" (errored, or answered anyway from training data): run the search in code with the
      // user's own question, discard any draft, and let the model answer from the results.
      if (mustSearch && !result.toolCalls.length && !result.cutOff) {
        if (result.content.trim()) emitModel({ type: 'reset' });
        delete timings.firstTokenMs;
        const args = JSON.stringify({ queries: [effective.replace(/\s+/g, ' ').slice(0, 200)] });
        const id = 'call_forced_search';
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'web_search', arguments: args } }] });
        messages.push({ role: 'tool', tool_call_id: id, content: await executeWebSearch(args, ctx) });
        (timings as Record<string, number>).forcedSearch = 1;
        continue;
      }

      if (result.toolCalls.length && canSearch && !result.cutOff) {
        if (result.content.trim()) emitModel({ type: 'reset' });
        delete timings.firstTokenMs; // measure the first token of the real answer, not a preface
        messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
        const outputs = await Promise.all(
          result.toolCalls.map((tc) =>
            tc.function.name === 'web_search' ? executeWebSearch(tc.function.arguments, ctx) : Promise.resolve(`Error: unknown tool ${tc.function.name}. Only web_search exists.`),
          ),
        );
        result.toolCalls.forEach((tc, i) => messages.push({ role: 'tool', tool_call_id: tc.id, content: outputs[i] }));
        // A comparison produced by a model-initiated `since` search is shown the same way.
        if (ctx.comparison && !prefix) {
          prefix = renderComparisonForUser(ctx.comparison);
          emit({ type: 'token', text: `${prefix}\n\n` });
          useful();
        }
        continue;
      }
      answer = result.content;
      cutOff = result.cutOff;
      if (cutOff) timedOut = true;
      break;
    }

    if (!answer.trim() && !timedOut && deadline.remaining() > 1500) {
      // Rare: the model returned nothing. One last attempt without tools, inside the deadline.
      emitModel({ type: 'reset' });
      const res = await streamRound(flatten(messages), undefined, emitModel, answerBudget, () => {});
      answer = res.content.trim();
      cutOff = res.cutOff;
      if (cutOff) timedOut = true;
    }
  } catch (err) {
    if (isAbortError(err) || deadline.expired()) {
      timedOut = true;
    } else {
      // Rate limits / provider errors: remember the question, never a fake answer.
      const id = persist('(No answer was produced: the model was unavailable.)', { timings: { ...timings, totalMs: Date.now() - t0 }, telemetry, error: (err as Error).message, failed: true }, true);
      remember(id, '', undefined, [], new Map());
      throw err;
    }
  }

  const evidence = registry.all();
  if (!answer.trim()) {
    if (timedOut && (prefix || evidence.length)) {
      // Out of time: deliver what is validated, and say what is missing.
      answer = prefix
        ? `_I ran out of time before writing the rest of the answer (${Math.round(B.turnMs / 1000)} s limit). The comparison above is complete for the sources checked._`
        : `I ran out of time (${Math.round(B.turnMs / 1000)} s limit) before I could write an answer. These sources came back and may help: ${evidence
            .slice(0, 5)
            .map((e) => `[${e.id}] ${e.title || e.domain} (${e.domain}, ${e.tier})`)
            .join('; ')}. Ask again and I'll pick up from them.`;
    } else {
      failed = true;
      answer = timedOut
        ? `I couldn't finish within the time limit (${Math.round(B.turnMs / 1000)} s), and no useful evidence came back in time. Please try again.`
        : "Sorry, I couldn't produce an answer this time. Please try again.";
    }
  } else if (cutOff) {
    answer += '\n\n_(Cut off at the time limit: this answer may be incomplete.)_';
  }
  timings.totalMs = Date.now() - t0;

  // 4. Checks on the model's text (code, not prompting)
  const valid = registry.ids();
  const comparisonTurn = r.changeIntent && (memory.turns.length > 0 || !!ctx.comparison);
  // Earlier answers the model can see: recalled turns + this chat's recent history.
  const priorAnswers = history.filter((m) => m.role === 'assistant' && !m.failed);
  const priorDates = [...new Set([...memory.turns.map((t) => t.user.local_date), ...priorAnswers.map((m) => m.local_date)])].sort();
  const seen = new Set(memory.claims.map((c) => c.id));
  const recorded = [...memory.claims, ...claimsForMessages(priorAnswers.map((m) => m.id)).filter((c) => !seen.has(c.id))];
  const pastInPlay = memory.turns.length > 0 || priorAnswers.length > 0;
  let narrative = validateCitations(answer, valid).text;
  let guardRemoved: string[] = [];
  let thenReplaced = 0;
  if (comparisonTurn) {
    // The comparison above is authoritative: the model's text can't re-invent Then values or verdicts.
    const g = guardNarrative(narrative, ctx.comparison, memory.claims);
    narrative = g.text;
    guardRemoved = g.removed;
  } else if (r.changeIntent || pastInPlay) {
    // Free-text path: a Then value must be a stored assertion (or a source dated on/before the anchor).
    // Runs on EVERY turn that has earlier answers in play (recalled, or earlier in this chat), not only
    // on turns the router tagged as "has it changed?": a follow-up like "3 Nov" or a repeated question
    // can still make the model write "same as $10 (3 Nov)".
    const anchor = windows.map((w) => w.from).sort()[0] ?? memory.anchorDate ?? priorDates[0] ?? today;
    const tc = checkThenValues(narrative, recorded.map((c) => ({ entity: c.entity, value: joinValue(c) })), evidence, anchor);
    thenReplaced = tc.replaced;
    // …and in prose: no "was $25 / unchanged" from a page fetched today.
    const g = guardNarrative(tc.text, null, recorded, { market: { evidence, anchor, today } });
    narrative = g.text;
    guardRemoved = g.removed;
  }
  // Auto-citation only after the Then checks, so it can never excuse an invented earlier value.
  const auto = autoCite(narrative, evidence);
  narrative = auto.text;
  const labels = enforceLabels(narrative, evidence, today);
  narrative = labels.text;
  const claimChecks = checkAnswerClaims(narrative, evidence);
  const unsupported = claimChecks.filter((c) => !c.supported && c.sources.length && !c.approximate);
  // More code checks on the model's text (each a live regression; see the modules):
  // Uncited prices: flagged whenever a search ran, and also when a time-sensitive question was answered
  // without one (recalled values from memory are not "uncited": they are what we said then).
  const flagUncited = evidence.length > 0 || (needsSearch(effective, r) && !memory.turns.length);
  const uncited = flagUncited ? claimChecks.filter((c) => !c.sources.length && !c.approximate) : [];
  // No search ran, yet the text claims provenance ("hubspot.com, fetched 12 Nov 2026"): say so.
  const fakeProvenance = !evidence.length && /\bfetched\b|\bas per [a-z0-9-]+\.[a-z]{2,}/i.test(narrative);
  const stale = stalePrices(claimChecks.filter((c) => c.supported), evidence, today);
  const ungrounded = checkGrounding(narrative, evidence, effective);
  // Prices the structured claim check didn't parse (any format) must still be in a cited source.
  // (A value we recorded earlier is an earlier value, checked by the Then guards above, not a source fact.)
  const parsedValues = new Set(claimChecks.filter((c) => c.sources.length).map((c) => c.value.replace(/\s+/g, '')));
  const valueMisses = checkCitedValues(narrative, evidence, recorded.map((c) => c.value))
    .map((v) => ({ ...v, values: v.values.filter((x) => !parsedValues.has(x)) }))
    .filter((v) => v.values.length);
  const earlier = memory.repeatOf?.assistant ? recorded.filter((c) => c.message_id === memory.repeatOf!.assistant!.id) : [];
  const drift = earlier.length ? inconsistencies(narrative, earlier) : [];
  const notes: string[] = [];
  if (thenReplaced)
    notes.push(`> ℹ️ No earlier value was recorded for ${thenReplaced} row${thenReplaced > 1 ? 's' : ''}, so ${thenReplaced > 1 ? 'they show' : 'it shows'} today's value only and can't be compared.`);
  if (drift.length && memory.repeatOf) {
    const when = prettyInstant(new Date(memory.repeatOf.user.created_at), memory.repeatOf.user.user_tz || tz);
    notes.push(
      `> ℹ️ **Different from my earlier answer (${when}):** ${drift
        .slice(0, 5)
        .map((d) => `${d.entity}${d.plan ? ` (${d.plan})` : ''} ${d.attribute.replace(/_/g, ' ')}: then ${d.then}, now ${d.now}`)
        .join('; ')}. Today's figure comes from the sources cited above; the earlier one may have come from an outdated page or a different plan.`,
    );
  }
  if (stale.length)
    notes.push(
      `> 🕒 **Possibly outdated:** ${stale
        .slice(0, 5)
        .map((s) => `${s.entity}${s.plan ? ` (${s.plan})` : ''} ${s.value} cites only ${s.sources.map((x) => `${x.id} (published ${x.publishedAt})`).join(', ')}`)
        .join('; ')}. Pages that old may quote superseded prices; check the vendor's current pricing page.`,
    );
  if (unsupported.length)
    notes.push(
      `> ⚠️ **Not confirmed by the cited source:** ${unsupported
        .slice(0, 5)
        // A column-derived attribute like "key points m philanthropic gift" is noise: keep short ones ("input price").
        .map((c) => `${c.entity}${c.plan ? ` (${c.plan})` : ''}${c.attribute.split('_').length <= 2 && c.attribute !== 'price' ? ` ${c.attribute.replace(/_/g, ' ')}` : ''} ${c.value}${c.reason ? `: ${c.reason}` : ''}`)
        .join('; ')}. Treat these as unverified.`,
    );
  if (valueMisses.length)
    notes.push(
      `> ⚠️ **Price not in the cited source:** ${valueMisses
        .slice(0, 5)
        .map((v) => `${v.values.join(', ')} in “${v.label}” [${v.ids.join(', ')}]`)
        .join('; ')}. Treat these as unverified.`,
    );
  if (uncited.length)
    notes.push(
      `> ℹ️ **No source cited for:** ${uncited
        .slice(0, 5)
        .map((c) => `${c.entity}${c.plan ? ` (${c.plan})` : ''} ${c.value}`)
        .join('; ')}. Treat these as unverified.`,
    );
  // Sources were retrieved, the answer is substantive, and it cites none of them.
  if (evidence.length && !validateCitations(narrative, valid).used.length && cleanLength(narrative) > 300 && !memory.turns.length)
    notes.push(`> ⚠️ **No citations:** this answer doesn't cite any of the ${evidence.length} sources retrieved, so none of it is tied to a source. Treat it as unverified.`);
  if (fakeProvenance)
    notes.push("> ⚠️ **No web search ran for this answer.** Any “fetched” date or site named above was not checked live; treat prices and facts as unverified.");
  if (ungrounded.length)
    notes.push(
      `> ⚠️ **Not found in the cited source** (the source doesn't mention these details, so treat the statement as unverified): ${ungrounded
        .slice(0, 5)
        .map((u) =>
          u.ids.length
            ? `“${u.label}” [${u.ids.join(', ')}]: ${u.missing.length ? `missing ${u.missing.map((m) => `“${m}”`).join(', ')}` : `only ${u.coverage}% of its wording is in the source`}`
            : `“${u.label}” (uncited; only ${u.coverage}% of its wording appears in any source retrieved)`,
        )
        .join('; ')}.`,
    );
  const finalText = [prefix, narrative, ...notes].filter((s) => s && s.trim()).join('\n\n');
  const cites = validateCitations(finalText, valid);
  const used = new Set(cites.used);
  const sources: PublicSource[] = evidence
    .map((e) => ({ id: e.id, url: e.url, domain: e.domain, title: e.title, tier: e.tier, publishedAt: e.publishedAt, retrievedAt: e.retrievedAt, cited: used.has(e.id) }))
    .sort((a, b) => Number(b.cited) - Number(a.cited));

  const debug = {
    timings,
    telemetry,
    deadline: { limitMs: deadline.totalMs, timedOut, cutOff, remainingMs: deadline.remaining() },
    model,
    rounds,
    fallbacks,
    windows,
    route: r,
    memory: debugMemory(memory),
    searches: ctx.logs,
    credits: ctx.logs.reduce((a, l) => a + l.credits, 0),
    diff: ctx.comparison?.rows ?? [],
    comparison: ctx.comparison ? { anchor: ctx.comparison.anchor, ...counts(ctx.comparison.rows), events: ctx.comparison.events.length, facts: ctx.comparison.facts.length } : null,
    prefetched: !!memory.recheck,
    failed,
    guard: { removed: guardRemoved, thenValuesRemoved: thenReplaced },
    clarification,
    checks: { stalePrices: stale, ungrounded, priceNotInSource: valueMisses, differsFromEarlier: drift, uncitedPrices: uncited.map((c) => `${c.entity} ${c.value}`) },
    citations: { used: cites.used, dropped: validateCitations(answer, valid).dropped, autoCited: auto.added, labelsDowngraded: labels.downgraded },
    claimCheck: claimChecks.map((c) => ({ entity: c.entity, plan: c.plan, attribute: c.attribute, value: c.value, sources: c.sources, supported: c.supported, approximate: c.approximate, reason: c.reason })),
  };

  // 5. Persist the turn, its evidence and its answer-linked memory BEFORE reporting completion.
  const messageId = persist(finalText, debug, failed);
  const sourceIds = new Map<string, number>();
  for (const e of evidence) {
    const sid = insertSource({
      url: e.url,
      canonical_url: e.canonicalUrl,
      domain: e.domain,
      title: e.title,
      published_at: e.publishedAt,
      retrieved_at: e.retrievedAt,
      content_hash: e.contentHash,
      excerpt: e.excerpt,
      tier: e.tier,
      tier_reason: e.tierReason ?? null,
      effective_date: e.observations?.find((o) => o.effectiveDate)?.effectiveDate ?? null,
    });
    sourceIds.set(e.id, sid);
    linkSource(messageId, sid, e.id, used.has(e.id));
  }
  const record = r.smallTalk ? (setMemoryStatus(messageId, 'none'), null) : remember(messageId, failed ? '' : finalText, failed ? undefined : narrative, failed ? [] : evidence, sourceIds);
  (debug as Record<string, unknown>).memoryWrite = record;

  emit({ type: 'final', text: finalText, sources, messageId, conversationId });
  emit({ type: 'debug', data: { stage: 'final', ...debug } });
  return { conversationId, messageId, answer: finalText, extraction: Promise.resolve(record), debug };
}

function debugMemory(memory: ReturnType<typeof retrieveMemory>) {
  return {
    block: memory.block,
    notes: memory.notes,
    turns: memory.turns.map((t) => ({ conversationId: t.conversationId, userMessageId: t.user.id, date: t.user.local_date, score: t.score, sameConversation: t.sameConversation, inHistory: t.inHistory })),
    claims: memory.claims.length,
    baselines: memory.baselines.length,
    facts: memory.facts.length,
    anchorDate: memory.anchorDate,
    ambiguous: memory.ambiguous,
    recheck: memory.recheck,
    repeatOf: memory.repeatOf ? { userMessageId: memory.repeatOf.user.id, date: memory.repeatOf.user.local_date } : null,
  };
}

interface RoundResult {
  content: string;
  toolCalls: ChatCompletionMessageToolCall[];
  model: string;
  /** The deadline stopped the stream: `content` is partial. */
  cutOff: boolean;
}

/** Stream one model round: forward tokens, accumulate tool calls. Partial text survives the deadline. */
async function streamRound(
  messages: ChatCompletionMessageParam[],
  toolChoice: 'auto' | 'none' | 'required' | undefined,
  emit: (e: TurnEvent) => void,
  budget: CallBudget,
  onFirstToken: () => void,
): Promise<RoundResult> {
  for (let attempt = 0; ; attempt++) {
    const { value: stream, provider } = await streamChat(
      {
        messages: fitToBudget(messages, config.budgets.maxPromptTokens, toolChoice ? TOOL_TOKENS : 0),
        ...(toolChoice ? { tools: [WEB_SEARCH_TOOL], tool_choice: toolChoice } : {}),
        max_completion_tokens: config.budgets.maxCompletionTokens,
        temperature: 0.3,
      },
      { ...budget, reasoningEffort: config.agentReasoning },
    );
    let content = '';
    const calls: { id: string; name: string; args: string }[] = [];
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          if (!content) onFirstToken();
          content += delta.content;
          emit({ type: 'token', text: delta.content });
        }
        for (const tc of delta.tool_calls ?? []) {
          const c = (calls[tc.index] ??= { id: '', name: '', args: '' });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
        }
      }
    } catch (err) {
      // The deadline stopped the stream: keep what was written.
      if (budget.signal?.aborted || isAbortError(err)) {
        if (content.trim()) return { content, toolCalls: [], model: provider.label, cutOff: true };
        throw budget.signal?.reason ?? new DeadlineError();
      }
      // Groq rejects a malformed tool call mid-stream (tool_use_failed) but returns what the model
      // generated: salvage it when it is a parseable web_search call (we validate args ourselves).
      const salvaged = salvageToolCall(err);
      if (salvaged) return { content: '', toolCalls: [salvaged], model: provider.label, cutOff: false };
      // Otherwise retry the round once, if there is time.
      if (attempt === 0 && (budget.remainingMs?.() ?? 1e9) > 2000) {
        if (budget.telemetry) budget.telemetry.llmRetries++;
        emit({ type: 'reset' });
        continue;
      }
      throw err;
    }
    const toolCalls: ChatCompletionMessageToolCall[] = calls
      .filter(Boolean)
      .map((c, i) => ({ id: c.id || `call_${i}_${Date.now()}`, type: 'function', function: { name: c.name.replace(/<\|.*$/, '').trim(), arguments: c.args || '{}' } }));
    return { content, toolCalls, model: provider.label, cutOff: false };
  }
}

function salvageToolCall(err: unknown): ChatCompletionMessageToolCall | null {
  const gen = (err as { error?: { failed_generation?: string } })?.error?.failed_generation;
  if (!gen) return null;
  try {
    const j = JSON.parse(gen) as { name?: string; arguments?: unknown };
    if (j.name !== 'web_search' || !j.arguments) return null;
    return { id: `call_salvaged_${Date.now()}`, type: 'function', function: { name: 'web_search', arguments: typeof j.arguments === 'string' ? j.arguments : JSON.stringify(j.arguments) } };
  } catch {
    return null;
  }
}

/** Rough token count: ~3 chars/token is deliberately pessimistic for tables, URLs and JSON. */
export const estimateTokens = (messages: ChatCompletionMessageParam[]): number =>
  Math.ceil(messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0) + ('tool_calls' in m && m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) / 3);

/**
 * Shorten a web_search result while keeping what must never be lost: every [S#] header line and
 * URL (so citations stay resolvable) and the whole <comparison> block (the authoritative verdict).
 * Only excerpt bodies are cut, to `bodyChars` per source.
 */
export function shrinkToolResult(content: string, bodyChars: number): string {
  const out: string[] = [];
  let inResults = !content.includes('<search_results');
  let inComparison = false;
  let used = 0;
  let marked = false;
  for (const line of content.split('\n')) {
    if (line.startsWith('<comparison')) inComparison = true;
    if (inComparison) {
      out.push(line);
      if (line.startsWith('</comparison>')) inComparison = false;
      continue;
    }
    if (line.startsWith('<search_results')) {
      inResults = true;
      out.push(line);
      continue;
    }
    if (line.startsWith('</search_results>')) {
      inResults = false;
      out.push(line);
      continue;
    }
    const header = (/^\[S\d+\] .*\| tier: /.test(line) || /^URL: /.test(line) || /^## /.test(line) || /^\[S\d+\] .*already shown/.test(line)) && content.includes('<search_results');
    if (!inResults || header) {
      out.push(line);
      if (header) {
        used = 0;
        marked = false;
      }
      continue;
    }
    if (used < bodyChars) {
      const take = line.slice(0, bodyChars - used);
      out.push(take);
      used += take.length + 1;
    } else if (!marked) {
      out.push('…[shortened to fit the token limit]');
      marked = true;
    }
  }
  return out.join('\n');
}

/**
 * Keep a request under the provider's per-request token limit, counting the WHOLE request: system
 * prompt, memory, history, tool results and the tool definition (`extraTokens`).
 * Order: older search results' excerpts → recent chat history → the newest search result's excerpts.
 * Never cut: [S#] headers, URLs, the <comparison> block, the system prompt and memory, the current
 * question. Live regression: a third search round pushed a request to 8,017 tokens (HTTP 413).
 */
export function fitToBudget(messages: ChatCompletionMessageParam[], maxPromptTokens: number, extraTokens = 0): ChatCompletionMessageParam[] {
  const fits = (ms: ChatCompletionMessageParam[]) => estimateTokens(ms) + extraTokens <= maxPromptTokens;
  if (fits(messages)) return messages;
  const out = messages.map((m) => ({ ...m })) as ChatCompletionMessageParam[];
  const original = messages.map((m) => (typeof m.content === 'string' ? m.content : ''));
  const toolIdx = out.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const older = toolIdx.slice(0, -1);
  const newest = toolIdx[toolIdx.length - 1];
  const set = (i: number, content: string) => ((out[i] as { content: string }).content = content);

  for (const keep of [1200, 600, 300, 120]) {
    for (const i of older) set(i, shrinkToolResult(original[i], keep));
    if (fits(out)) return out;
  }
  const current = out.map((m) => m.role).lastIndexOf('user');
  const historyIdx = out.map((m, i) => ((m.role === 'user' || m.role === 'assistant') && i < current && !('tool_calls' in m && m.tool_calls) ? i : -1)).filter((i) => i >= 0);
  for (const cap of [800, 300]) {
    for (const i of historyIdx) if (original[i].length > cap) set(i, `${original[i].slice(0, cap)} …[shortened]`);
    if (fits(out)) return out;
  }
  if (newest !== undefined) {
    for (const keep of [800, 400, 150, 0]) {
      set(newest, shrinkToolResult(original[newest], keep));
      if (fits(out)) return out;
    }
  }
  return out;
}

/** Collapse tool-call history into plain messages (for providers/rounds without tools). */
function flatten(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  const evidence: string[] = [];
  for (const m of messages) {
    if (m.role === 'tool') evidence.push(String(m.content));
    else if (m.role === 'assistant' && 'tool_calls' in m && m.tool_calls?.length) continue;
    else out.push(m);
  }
  if (evidence.length) out.push({ role: 'system', content: `Evidence gathered by web_search this turn:\n${evidence.join('\n\n')}\n\nWrite the final answer now.` });
  return out;
}
