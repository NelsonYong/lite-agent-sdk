import type { Middleware } from "./middleware";
import { ProviderError } from "./events";

// Transient HTTP statuses worth retrying. A ProviderError with no status
// (network/connection failure) is also treated as transient.
const TRANSIENT = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const defaultRetryOn = (err: unknown): boolean =>
  err instanceof ProviderError && (err.status === undefined || TRANSIENT.has(err.status));

const defaultBackoff = (attempt: number): number => Math.min(250 * 2 ** (attempt - 1), 8000);

export interface RetryOptions {
  /** Retries after the first attempt. Default 2 (→ up to 3 total attempts). */
  maxRetries?: number;
  /** ms to wait before retry N (1-based). Default exponential 250ms→8s. */
  backoff?: (attempt: number) => number;
  /** Whether an error is retryable. Default: transient ProviderError. */
  retryOn?: (err: unknown) => boolean;
}

// A detachable retry block: wraps the model stream and re-runs it on transient
// failures. Plugs into the existing `wrapModelCall` contract — add via `use: [retry()]`.
// It only retries failures that happen BEFORE any chunk is emitted, so a partially
// streamed response is never duplicated.
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
          if (started || attempt >= maxRetries || !retryOn(err)) throw err;
          attempt++;
          const ms = backoff(attempt);
          if (ms > 0) await new Promise((r) => setTimeout(r, ms));
        }
      }
    },
  };
}
