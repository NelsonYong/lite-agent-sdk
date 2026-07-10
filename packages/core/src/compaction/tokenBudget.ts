import type { Compactor, TokenEstimator } from "../strategies";
import type { Message } from "../types";
import { estimateTokens } from "./types";
import { splitTurns } from "./snip";

export interface TokenBudgetCompactorOptions {
  maxTokens: number;
  estimator?: TokenEstimator;
  /** At least this many newest turns survive even if they exceed the budget. Default 1. */
  minTailTurns?: number;
}

export function tokenBudgetCompactor(opts: TokenBudgetCompactorOptions): Compactor {
  if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0)
    throw new Error("token budget must be a positive finite number");
  const estimate = opts.estimator ?? estimateTokens;
  const minTail = Math.max(1, opts.minTailTurns ?? 1);
  return {
    async maybeCompact(messages) {
      const before = await estimate(messages);
      if (before <= opts.maxTokens) return { messages, before, after: before };
      const turns = splitTurns(messages);
      const kept: Message[][] = [];
      let used = 0;
      for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i]!;
        const cost = await estimate(turn);
        if (kept.length >= minTail && used + cost > opts.maxTokens) break;
        kept.unshift(turn);
        used += cost;
      }
      const dropped = turns.length - kept.length;
      if (dropped <= 0) return { messages, before, after: before };
      const marker: Message = { role: "user", content: `[${dropped} earlier turn(s) omitted to fit the local context budget]` };
      const out = [marker, ...kept.flat()];
      return { messages: out, kind: "auto", before, after: await estimate(out) };
    },
  };
}
