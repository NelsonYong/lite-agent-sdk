import type { Compactor } from "../strategies";
import type { Middleware } from "../middleware";
import { abortable } from "../channel";
import { estimateTokens } from "./types";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 };

export function compaction(compactor: Compactor): Middleware {
  return {
    name: "compaction",
    async beforeModel(ctx) {
      const before = estimateTokens(ctx.messages);
      ctx.emit({ type: "compaction", kind: "micro", phase: "start", stage: "measure", before, after: before });
      try {
        const result = await abortable(compactor.maybeCompact(ctx.messages, ZERO_USAGE, undefined, ctx.signal), ctx.signal);
        ctx.signal.throwIfAborted();
        ctx.messages = result.messages;
        ctx.emit({ type: "compaction", kind: result.kind ?? "micro", phase: "done", before: result.before ?? before, after: result.after ?? estimateTokens(result.messages) });
      } catch (error) {
        ctx.emit({ type: "compaction", kind: "micro", phase: ctx.signal.aborted ? "cancelled" : "error", before, after: before, message: String(error) });
        throw error;
      }
    },
  };
}
