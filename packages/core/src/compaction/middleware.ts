import type { Compactor } from "../strategies";
import type { Middleware } from "../middleware";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 };

// The compaction block: a beforeModel middleware that runs a Compactor over the
// turn's context and swaps in the compacted view (emitting a compaction event
// only when it actually changed). Plug in via use: [compaction(defaultCompactor())].
export function compaction(compactor: Compactor): Middleware {
  return {
    name: "compaction",
    async beforeModel(ctx) {
      const r = await compactor.maybeCompact(ctx.messages, ZERO_USAGE);
      if (r.messages !== ctx.messages) {
        ctx.emit({ type: "compaction", kind: r.kind ?? "micro", before: r.before ?? 0, after: r.after ?? 0 });
        ctx.messages = r.messages;
      }
    },
  };
}
