// Deterministic pre-routing (no extra LLM hop): does this turn need memory, is it a
// "has anything changed / is it still correct?" question, is it a pure "what did I ask?" recall,
// does it ask about launches, or is it small talk (no tools at all)?

export interface Route {
  memoryIntent: boolean;
  changeIntent: boolean;
  /** Only asks what was said/asked before: answerable from memory alone. */
  pureRecall: boolean;
  /** Asks about launches / releases / announcements ("shipped something big"). */
  launchIntent: boolean;
  /** Greeting / thanks: no search, no extraction. */
  smallTalk: boolean;
}

const MEMORY_RE =
  /\b(i|we)\s+(asked|discussed|talked|shortlisted|short-listed|said|mentioned|looked|compared|chatted|picked|chose|decided|spoke|researched|went over)\b|\byou\s+(said|told|recommended|suggested|answered|mentioned|gave|listed|found)\b|\b(earlier|last time|previously|before)\b.*\b(asked|said|discussed|talked|answer)|\bour (conversation|chat|discussion|shortlist|list)\b|\bremember\b|\bwhat did (i|we|you)\b|\bthe (shortlist|list) (we|you)\b|\byour (earlier |previous |last )?answer\b/i;

const CHANGE_RE =
  /\bchang(e|ed|es)\b|\bstill (correct|valid|true|accurate|right|the same|current)\b|\bsince (then|monday|tuesday|wednesday|thursday|friday|saturday|sunday|last|\d|the)\b|\bany (updates?|news)\b|\bupdated?\b|\bdiffer(ent)?\b|\bwent (up|down)\b|\b(increase|decrease|drop|rise|raise)[ds]?\b|\bshipped\b|\b(new|latest) (release|version|pricing|price)\b|\bout of date\b|\boutdated\b/i;

const LAUNCH_RE = /\bship(ped|s)?\b|\blaunch(ed|es)?\b|\breleas(e|ed|es)\b|\bannounc(e|ed|es|ement|ements)\b|\bnew features?\b|\bsomething (big|new|major)\b|\bwhat'?s new\b|\bany news\b/i;

const PURE_RECALL_RE =
  /^\s*(?:(?:so|ok|okay|hey|hi),?\s+)?(?:what|which|when)\b[^?]*\b(?:did|have|had)\s+(?:i|we)\s+(?:ask|asked|discuss|talk|talked|say|mention|shortlist|compare|look|chat)\b[^?]*\??\s*$|^\s*(?:remind me|do you remember)\b[^?]*\??\s*$|^\s*did (?:i|we) (?:ask|talk|discuss|chat)\b[^?]*\??\s*$/i;

const SMALL_TALK = /^\s*(?:hi|hello|hey|yo|hiya|thanks|thank you|thx|ty|cheers|good (?:morning|afternoon|evening|night)|how are you(?: doing)?|ok(?:ay)?|cool|great|nice|bye|goodbye|see you)(?:\s+(?:there|minimi|again|so much|a lot))?[\s!.?,:)]*$/i;

/**
 * "Postgres last Tuesday?": a bare topic plus a date, no question words. In a chat with memory this
 * means "what did we discuss about X on that day". Live regression: it was routed as a world question,
 * memory was never consulted, and the model asked which Tuesday although only one held a Postgres chat.
 */
const WORLD_WORDS = /\b(what|how|who|why|where|which|is|are|does|do|can|will|should|latest|news|price|prices|pricing|cost|weather|release|released|launch|launched|happened|happening)\b/i;
function topicWithDate(message: string, hasDateWindows: boolean): boolean {
  if (!hasDateWindows) return false;
  const words = message.trim().split(/\s+/);
  return message.length <= 50 && words.length <= 6 && !WORLD_WORDS.test(message);
}

export function route(message: string, hasDateWindows: boolean): Route {
  const changeIntent = CHANGE_RE.test(message);
  const memoryIntent = MEMORY_RE.test(message) || (hasDateWindows && /\b(i|we|you)\b/i.test(message)) || topicWithDate(message, hasDateWindows);
  const pureRecall = memoryIntent && !changeIntent && message.length <= 200 && PURE_RECALL_RE.test(message);
  const launchIntent = LAUNCH_RE.test(message);
  const smallTalk = message.length <= 40 && SMALL_TALK.test(message);
  return { memoryIntent, changeIntent, pureRecall, launchIntent, smallTalk };
}
