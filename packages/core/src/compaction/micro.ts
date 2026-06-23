import type { Message } from "../types";
import type { CompactPass } from "./types";
import { SPILL_PREFIX } from "./types";

export interface MicroPassOptions {
  /** How many of the most recent tool_results keep their full body. Default 3. */
  keepRecent?: number;
  placeholder?: string;
}

// L2 microCompact: shrink OLD tool_result bodies to a placeholder while keeping
// the most recent N intact. Edits text in place — never deletes a block — so the
// tool_call ↔ tool_result pairing the provider requires stays intact.
export function microPass(opts: MicroPassOptions = {}): CompactPass {
  const keepRecent = opts.keepRecent ?? 3;
  const placeholder = opts.placeholder ?? "[tool result omitted to save context]";
  return {
    name: "micro",
    apply(messages) {
      const positions: Array<[number, number]> = [];
      messages.forEach((m, mi) => {
        if (Array.isArray(m.content)) {
          m.content.forEach((b, bi) => {
            if (b.type === "tool_result") positions.push([mi, bi]);
          });
        }
      });
      if (positions.length <= keepRecent) return messages;

      const omit = new Set(positions.slice(0, positions.length - keepRecent).map(([mi, bi]) => `${mi}:${bi}`));
      let anyChanged = false;
      const out = messages.map((m, mi) => {
        if (!Array.isArray(m.content)) return m;
        let changed = false;
        const content = m.content.map((b, bi) => {
          if (b.type === "tool_result" && omit.has(`${mi}:${bi}`) && b.content !== placeholder && !b.content.startsWith(SPILL_PREFIX)) {
            changed = true;
            return { ...b, content: placeholder };
          }
          return b;
        });
        if (!changed) return m;
        anyChanged = true;
        return { ...m, content };
      });
      return anyChanged ? out : messages;
    },
  };
}
