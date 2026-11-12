// OpenAI-SDK clients pointed at OpenAI-compatible endpoints (Groq first, optional fallbacks).
// Waiting is bounded by the turn deadline: every request gets the deadline's AbortSignal and a
// timeout no longer than the time left, and a rate-limit wait happens only when it fits.
// One pass over the provider chain; no second tour (that used to add up to a minute).

import OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { z } from 'zod';
import { type ProviderConfig, config } from '../config.js';
import { type Telemetry, DeadlineError, abortableSleep, isAbortError } from '../agent/deadline.js';

const clients = new Map<string, OpenAI>();

function clientFor(p: ProviderConfig): OpenAI {
  const key = p.baseURL + p.apiKey.slice(0, 8);
  let c = clients.get(key);
  if (!c) {
    c = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL, maxRetries: 0, timeout: config.budgets.requestTimeoutMs });
    clients.set(key, c);
  }
  return c;
}

function status(err: unknown): number | undefined {
  return (err as { status?: number })?.status;
}

function retryAfterMs(err: unknown): number | null {
  const h = (err as { headers?: Headers | Record<string, string> })?.headers;
  const v = h ? (typeof (h as Headers).get === 'function' ? (h as Headers).get('retry-after') : (h as Record<string, string>)['retry-after']) : null;
  if (v) {
    const secs = Number(v);
    if (!Number.isNaN(secs)) return secs * 1000;
    const at = Date.parse(v);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  // Groq also states it in the message: "Please try again in 45.53s" / "in 1m2.5s".
  const m = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(String((err as Error)?.message ?? ''));
  return m ? (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000 : null;
}

export type FallbackEvent = { from: string; reason: string };

export interface CallBudget {
  /** Aborts in-flight requests and waits (the turn deadline or a phase of it). */
  signal?: AbortSignal;
  /** Milliseconds left for this call; requests time out and waits are skipped accordingly. */
  remainingMs?: () => number;
  telemetry?: Telemetry;
  onFallback?: (e: FallbackEvent) => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeout: number;
}

/**
 * Run `call` against each provider in `chain` until one succeeds, within the caller's budget.
 * 429 → wait for retry-after on the same provider once, only if that wait is short and fits the
 *       remaining budget; otherwise move to the next provider.
 * 5xx / network errors → next provider. Other 4xx → rethrow (a request bug, not capacity).
 * Abort (deadline) → rethrow immediately.
 */
export async function withFallback<T>(
  chain: ProviderConfig[],
  call: (client: OpenAI, p: ProviderConfig, req: RequestOptions) => Promise<T>,
  budget: CallBudget = {},
): Promise<{ value: T; provider: ProviderConfig }> {
  if (!chain.length) throw new Error('No LLM provider configured: set GROQ_API_KEY in .env');
  const remaining = budget.remainingMs ?? (() => config.budgets.requestTimeoutMs);
  const maxWait = config.budgets.rateLimitMaxWaitMs;
  let lastErr: unknown;
  let calls = 0;
  for (const p of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = remaining();
      if (budget.signal?.aborted || left < 300) throw budget.signal?.reason ?? new DeadlineError();
      if (budget.telemetry) {
        budget.telemetry.llmCalls++;
        if (calls > 0) budget.telemetry.llmRetries++;
      }
      calls++;
      try {
        return { value: await call(clientFor(p), p, { signal: budget.signal, timeout: Math.min(config.budgets.requestTimeoutMs, left) }), provider: p };
      } catch (err) {
        lastErr = err;
        if (budget.signal?.aborted || isAbortError(err)) throw budget.signal?.reason ?? err;
        const s = status(err);
        if (s === 429) {
          const wait = retryAfterMs(err);
          // Keep 2 s for the request itself after the wait.
          if (attempt === 0 && wait !== null && wait <= maxWait && wait + 2000 < remaining()) {
            budget.onFallback?.({ from: p.label, reason: `free-tier rate limit, waiting ${Math.ceil(wait / 1000)}s` });
            const t = Date.now();
            await abortableSleep(wait + 200, budget.signal);
            if (budget.telemetry) budget.telemetry.llmWaitMs += Date.now() - t;
            continue;
          }
          budget.onFallback?.({ from: p.label, reason: 'rate limited, trying the next model' });
          break;
        }
        if (s !== undefined && s >= 400 && s < 500 && s !== 408 && s !== 413) {
          // Groq returns 400 tool_use_failed when the model emits a malformed tool call: retry once.
          if (s === 400 && /tool_use_failed|failed to call a function|parse/i.test(String((err as Error).message)) && attempt === 0) continue;
          throw err;
        }
        budget.onFallback?.({ from: p.label, reason: s ? `HTTP ${s}` : (err as Error).message?.slice(0, 80) || 'error' });
        break;
      }
    }
  }
  throw lastErr;
}

/** Start a streaming chat completion with fallback. Resolves once the stream is open. */
export async function streamChat(
  params: Omit<ChatCompletionCreateParamsStreaming, 'model' | 'stream'>,
  opts: CallBudget & { chain?: ProviderConfig[]; reasoningEffort?: 'low' | 'medium' | 'high' } = {},
) {
  return withFallback(
    opts.chain ?? config.agentChain,
    (c, p, req) =>
      c.chat.completions.create(
        {
          ...params,
          model: p.model,
          stream: true,
          ...(p.reasoning ? { reasoning_effort: opts.reasoningEffort ?? 'medium' } : {}),
        } as ChatCompletionCreateParamsStreaming,
        req,
      ),
    opts,
  );
}

/**
 * JSON-mode completion validated with zod. One repair retry with the validation error, both
 * inside the caller's budget. Uses the extraction chain (small model first) so it doesn't eat the
 * main model's TPM.
 */
export async function chatJSON<S extends z.ZodTypeAny>(
  messages: ChatCompletionMessageParam[],
  schema: S,
  opts: CallBudget & { chain?: ProviderConfig[]; maxTokens?: number } = {},
): Promise<{ data: z.infer<S>; model: string }> {
  let msgs = messages;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (opts.telemetry) opts.telemetry.extractionCalls++;
    const { value, provider } = await withFallback(
      opts.chain ?? config.extractChain,
      (c, p, req) =>
        c.chat.completions.create(
          {
            model: p.model,
            messages: msgs,
            response_format: { type: 'json_object' },
            max_completion_tokens: opts.maxTokens ?? 2000,
            temperature: 0,
            ...(p.reasoning ? { reasoning_effort: 'low' } : {}),
          } as OpenAI.ChatCompletionCreateParamsNonStreaming,
          req,
        ),
      opts,
    );
    const text = value.choices[0]?.message?.content ?? '';
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      if (parsed.success) return { data: parsed.data, model: provider.label };
      lastError = parsed.error.message.slice(0, 600);
    } catch (e) {
      lastError = `invalid JSON: ${(e as Error).message}`;
    }
    msgs = [...messages, { role: 'assistant', content: text.slice(0, 2000) }, { role: 'user', content: `That output was invalid (${lastError}). Return only corrected JSON matching the schema.` }];
  }
  throw new Error(`JSON extraction failed: ${lastError}`);
}
