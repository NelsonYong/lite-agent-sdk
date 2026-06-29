import type { Middleware } from "./middleware";
import { AgentError, ProviderError } from "./events";

// Transient HTTP statuses worth retrying. A ProviderError with no status
// (network/connection failure) is also treated as transient.
const TRANSIENT = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const defaultRetryOn = (err: unknown): boolean =>
  err instanceof ProviderError && (err.status === undefined || TRANSIENT.has(err.status));

// Exponential backoff with full jitter: a random delay in [0, ceiling] so that
// many agents hitting the same transient failure don't retry in lockstep
// (avoids a synchronized thundering-herd against a recovering endpoint).
const defaultBackoff = (attempt: number): number =>
  Math.random() * Math.min(250 * 2 ** (attempt - 1), 8000);

export interface RetryOptions {
  /** Retries after the first attempt. Default 2 (→ up to 3 total attempts). */
  maxRetries?: number;
  /** ms to wait before retry N (1-based). Default exponential 250ms→8s with full jitter. */
  backoff?: (attempt: number) => number;
  /** Whether an error is retryable. Default: transient ProviderError. */
  retryOn?: (err: unknown) => boolean;
}

// A detachable retry block: wraps the model stream and re-runs it on transient
// failures. Plugs into the existing `wrapModelCall` contract — add via `use: [retry()]`.
// It only retries failures that happen BEFORE any chunk is emitted, so a partially
// streamed response is never duplicated. Aborting the run stops retries immediately,
// including interrupting an in-progress backoff wait.
export function retry(opts: RetryOptions = {}): Middleware {
  const maxRetries = opts.maxRetries ?? 2;
  const backoff = opts.backoff ?? defaultBackoff;
  const retryOn = opts.retryOn ?? defaultRetryOn;
  return {
    name: "retry",
    async *wrapModelCall(ctx, next) {
      let attempt = 0;
      while (true) {
        let started = false;
        try {
          for await (const chunk of next()) {
            started = true;
            yield chunk;
          }
          return;
        } catch (err) {
          // No retry once a partial response streamed, past the budget, on a
          // non-retryable error, or after the run was aborted.
          if (started || attempt >= maxRetries || !retryOn(err) || ctx.signal.aborted) throw err;
          attempt++;
          ctx.emit({ type: "error", error: asAgentError(err), fatal: false });
          await sleep(backoff(attempt), ctx.signal);
          if (ctx.signal.aborted) throw err; // aborted mid-backoff: surface, don't retry
        }
      }
    },
  };
}

const asAgentError = (err: unknown): AgentError =>
  err instanceof AgentError
    ? err
    : new ProviderError(err instanceof Error ? err.message : String(err));

// Resolves after `ms`, or early (without rejecting) if the signal aborts.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
