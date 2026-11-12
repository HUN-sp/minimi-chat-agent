// One deadline per turn, shared by every phase (prefetch, search, extraction, answer, fallback).
// Each in-flight operation receives an AbortSignal, so waiting stops when the deadline expires.
// Checking a loop condition between operations is not enough.

export class DeadlineError extends Error {
  constructor(message = 'turn deadline reached') {
    super(message);
    this.name = 'DeadlineError';
  }
}

export interface Telemetry {
  llmCalls: number; // every provider request (agent rounds + extraction), including retries
  llmRetries: number; // repeated requests: rate-limit waits, malformed tool calls, fallbacks
  llmWaitMs: number; // time spent sleeping on retry-after
  extractionCalls: number; // JSON extraction requests (subset of llmCalls)
  searchCalls: number; // Tavily requests (cache hits excluded)
  searchRetries: number;
}

export const newTelemetry = (): Telemetry => ({ llmCalls: 0, llmRetries: 0, llmWaitMs: 0, extractionCalls: 0, searchCalls: 0, searchRetries: 0 });

export class Deadline {
  readonly start = Date.now();
  readonly at: number;
  private readonly ctrl = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(readonly totalMs: number) {
    this.at = this.start + totalMs;
    this.timer = setTimeout(() => this.ctrl.abort(new DeadlineError()), totalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Aborts when the turn deadline is reached. */
  get signal(): AbortSignal {
    return this.ctrl.signal;
  }

  remaining(): number {
    return Math.max(0, this.at - Date.now());
  }

  expired(): boolean {
    return this.ctrl.signal.aborted || this.remaining() <= 0;
  }

  /** A signal that fires `reserveMs` before the deadline: for phases that must leave time to answer. */
  phaseSignal(reserveMs: number): AbortSignal {
    const ms = Math.max(1, this.remaining() - reserveMs);
    return AbortSignal.any([this.signal, AbortSignal.timeout(ms)]);
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** Was this error caused by an abort (deadline, phase timeout or caller cancellation)? */
export function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; cause?: unknown } | null;
  if (!e) return false;
  if (e instanceof DeadlineError) return true;
  if (['AbortError', 'TimeoutError', 'DeadlineError', 'APIUserAbortError'].includes(e.name ?? '')) return true;
  return e.cause ? isAbortError(e.cause) : false;
}

/** setTimeout as a promise that rejects as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DeadlineError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason ?? new DeadlineError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
