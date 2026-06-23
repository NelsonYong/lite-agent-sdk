import type { Compactor } from "../strategies";
import type { CompactPass } from "./types";
import { runPipeline, estimateTokens } from "./types";
import { snipPass } from "./snip";
import { microPass } from "./micro";
import { toolResultBudgetPass } from "./budget";
import type { SpillStore } from "./budget";

export interface DefaultCompactorOptions {
  /** snip: only snip beyond this many messages. Default 50. */
  maxMessages?: number;
  /** snip: leading turns always kept. Default 1. */
  headTurns?: number;
  /** snip: keep trailing turns until this many messages retained. Default 20. */
  tailKeep?: number;
  /** micro: how many recent tool_results keep full bodies. Default 3. */
  keepRecentToolResults?: number;
  /** L3: when set, spill oversized tool_results to this store (runs first). */
  spillStore?: SpillStore;
  /** L3: spill largest tool_results until total body bytes ≤ this. Default 200_000. */
  budgetBytes?: number;
  /** Replace the whole pass pipeline (hot-swap). Defaults to [spill?] → snip → micro. */
  passes?: CompactPass[];
}

// Deterministic, 0-API Compactor: assembles structural bricks into a pipeline
// (cheap/structural first) and wraps them in the fixed Compactor interface. An
// LLM-summary compactor can later drop in behind this same interface.
export function defaultCompactor(opts: DefaultCompactorOptions = {}): Compactor {
  const passes = opts.passes ?? [
    ...(opts.spillStore ? [toolResultBudgetPass({ store: opts.spillStore, budgetBytes: opts.budgetBytes })] : []),
    snipPass({ maxMessages: opts.maxMessages, headTurns: opts.headTurns, tailKeep: opts.tailKeep }),
    microPass({ keepRecent: opts.keepRecentToolResults }),
  ];
  return {
    async maybeCompact(messages) {
      const before = estimateTokens(messages);
      const out = runPipeline(passes, messages);
      if (out === messages) return { messages, before, after: before };
      return { messages: out, kind: "micro", before, after: estimateTokens(out) };
    },
  };
}
