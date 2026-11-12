// Central configuration: env, clock (FAKE_NOW), model chain, budgets.

const env = process.env;

export interface ProviderConfig {
  label: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /** Groq's gpt-oss models accept reasoning_effort; others may not. */
  reasoning: boolean;
}

const GROQ_URL = 'https://api.groq.com/openai/v1';

function providers(primaryModel: string, secondaryModel: string): ProviderConfig[] {
  const list: ProviderConfig[] = [];
  if (env.GROQ_API_KEY) {
    list.push({ label: `groq:${primaryModel}`, baseURL: GROQ_URL, apiKey: env.GROQ_API_KEY, model: primaryModel, reasoning: true });
    list.push({ label: `groq:${secondaryModel}`, baseURL: GROQ_URL, apiKey: env.GROQ_API_KEY, model: secondaryModel, reasoning: true });
  }
  if (env.GEMINI_API_KEY) {
    list.push({
      label: 'gemini:gemini-2.5-flash',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: env.GEMINI_API_KEY,
      model: 'gemini-2.5-flash',
      reasoning: false,
    });
  }
  if (env.OPENROUTER_API_KEY) {
    list.push({
      label: 'openrouter:gpt-oss-120b:free',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: env.OPENROUTER_API_KEY,
      model: 'openai/gpt-oss-120b:free',
      reasoning: false,
    });
  }
  return list;
}

const MAIN_MODEL = env.GROQ_MODEL ?? 'openai/gpt-oss-120b';
const SMALL_MODEL = env.GROQ_FALLBACK_MODEL ?? 'openai/gpt-oss-20b';

export const config = {
  port: Number(env.PORT ?? 3000),
  dbPath: env.DB_PATH ?? 'data/minimi.db',
  tavilyKey: env.TAVILY_API_KEY ?? '',
  /** Main agent: big model first, then fallbacks. */
  agentChain: providers(MAIN_MODEL, SMALL_MODEL),
  /** JSON extraction jobs: small model first. Groq rate limits are per model, so this keeps the main model's TPM free. */
  extractChain: providers(SMALL_MODEL, MAIN_MODEL),
  budgets: {
    maxRounds: 3, // model ↔ search round-trips
    maxRoundsAfterPrefetch: 1, // extra search rounds once a re-check prefetch already ran
    maxQueries: 8, // queries per turn (each may be 1–3 Tavily calls)
    /** One deadline for the whole turn: prefetch, search, extraction, answer and fallbacks. */
    turnMs: Number(env.TURN_DEADLINE_MS ?? 25_000),
    /** Time kept back for writing the answer: searching and extraction stop this long before the deadline. */
    answerReserveMs: 8_000,
    /** A new search round starts only if at least this much search time is left (beyond the reserve). */
    minSearchMs: 4_000,
    /** Longest rate-limit wait on one provider before moving on to the next. */
    rateLimitMaxWaitMs: 6_000,
    /** Per-request ceiling; the remaining turn budget is usually lower. */
    requestTimeoutMs: 60_000,
    resultsPerQuery: 5,
    resultsPerQueryPaired: 3, // per side when `since` triggers the primary+news pair
    excerptChars: 1200,
    sectionChars: 1600, // what the model is shown per source (official pages: twice this), in whole chunks
    chunkChars: 1200, // one self-contained excerpt chunk: heading path + table header + rows
    toolResultChars: 7_500, // whole tool result, ≈2.8k tokens (Groq free tier: 8k TPM)
    memoryChars: 6000, // ≈1.5k tokens
    historyMessages: 6,
    maxCompletionTokens: 1500,
    /** Groq free tier counts prompt + max_completion_tokens against 8,000 TPM per request: 8000 − 1500 − margin.
     *  Counted over the WHOLE request: system prompt, memory, history, tool results and tool definitions. */
    maxPromptTokens: 5800,
  },
  /** gpt-oss reasoning effort for agent rounds: "low" keeps first-token latency down; code does the hard checks. */
  agentReasoning: (env.AGENT_REASONING as 'low' | 'medium' | 'high') ?? 'low',
  cacheTtlMs: 15 * 60_000,
};

// ---- Clock -------------------------------------------------------------------

let nowOverride: Date | null = null;

/** Current time. Honors FAKE_NOW (e.g. 2026-11-11T10:00:00) and test/seed overrides. */
export function getNow(): Date {
  if (nowOverride) return new Date(nowOverride);
  if (env.FAKE_NOW) return new Date(env.FAKE_NOW);
  return new Date();
}

export function setNowOverride(d: Date | null): void {
  nowOverride = d;
}

export function defaultTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
