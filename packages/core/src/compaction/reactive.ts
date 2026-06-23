import type { Message } from "../types";
import type { Middleware } from "../middleware";
import { ProviderError } from "../events";
import { estimateTokens } from "./types";
import { splitTurns } from "./snip";

export interface ReactiveTrimOptions {
  /** Max recent turns to keep. Default 2. */
  keepTurns?: number;
  /** Approx token cap on the kept tail. Default 4000. */
  tokenBudget?: number;
}

// Emergency trim: drop ALL but the most recent few turns (within a token cap)
// and prefix a placeholder. Turn-aware so tool_call/tool_result pairs stay whole;
// LLM-free so it can never itself overflow. More aggressive than snip (drops head).
export function reactiveTrim(messages: Message[], opts: ReactiveTrimOptions = {}): Message[] {
  const keepTurns = opts.keepTurns ?? 2;
  const budget = opts.tokenBudget ?? 4000;
  const turns = splitTurns(messages);
  const kept: Message[][] = [];
  let toks = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (kept.length >= 1 && (kept.length >= keepTurns || toks + estimateTokens(t) > budget)) break;
    kept.unshift(t);
    toks += estimateTokens(t);
  }
  const dropped = turns.length - kept.length;
  if (dropped <= 0) return messages;
  const placeholder: Message = { role: "user", content: `[${dropped} earlier turn(s) dropped — context overflow]` };
  return [placeholder, ...kept.flat()];
}

export interface ReactiveCompactionOptions {
  /** How to trim on overflow. Default reactiveTrim with its defaults. */
  trim?: (messages: Message[]) => Message[];
  /** Classify an error as a context-overflow. Default: ProviderError 413 / prompt_too_long. */
  isOverflow?: (err: unknown) => boolean;
  /** Reactive retries after the first failure. Default 1. */
  maxAttempts?: number;
}

function defaultIsOverflow(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (err.status === 413) return true;
  return /prompt[\s_]?too[\s_]?long|context[\s_]?length|too many tokens|maximum context/i.test(err.message);
}

// The reactive safety-net block: a wrapModelCall middleware that catches a
// context-overflow rejection, aggressively trims ctx.messages (LLM-free) and
// retries. Relies on the kernel re-encoding from ctx.messages each call.
// Only retries failures that occur BEFORE any chunk streamed (no dup output).
export function reactiveCompaction(opts: ReactiveCompactionOptions = {}): Middleware {
  const trim = opts.trim ?? ((m: Message[]) => reactiveTrim(m));
  const isOverflow = opts.isOverflow ?? defaultIsOverflow;
  const maxAttempts = opts.maxAttempts ?? 1;
  return {
    name: "reactive-compaction",
    async *wrapModelCall(ctx, next) {
      let attempts = 0;
      while (true) {
        let started = false;
        try {
          for await (const chunk of next()) {
            started = true;
            yield chunk;
          }
          return;
        } catch (err) {
          if (started || !isOverflow(err) || attempts >= maxAttempts) throw err;
          attempts++;
          const before = estimateTokens(ctx.messages);
          ctx.messages = trim(ctx.messages);
          ctx.emit({ type: "compaction", kind: "auto", before, after: estimateTokens(ctx.messages) });
        }
      }
    },
  };
}
