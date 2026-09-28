import type { ContentBlock, Message } from "../types";
import type { CompactPass } from "./types";
import { SPILL_PREFIX } from "./types";

// Off-context blob store; asynchronous backends may encode before committing.
export interface SpillStore {
  put(content: string): string | Promise<string>; // returns an opaque ref
  get(ref: string): string | null | Promise<string | null>;
}

// In-memory default, mirroring memoryStore/noopSandbox.
export function memorySpillStore() {
  const blobs = new Map<string, string>();
  let n = 0;
  return {
    put(content: string) {
      const ref = `m${++n}`;
      blobs.set(ref, content);
      return ref;
    },
    get(ref: string) {
      return blobs.get(ref) ?? null;
    },
  };
}

export interface ToolResultBudgetOptions {
  store: SpillStore;
  /** Spill the largest tool_results until total body bytes ≤ this. Default 200_000. */
  budgetBytes?: number;
}

const isSpilled = (s: string) => s.startsWith(SPILL_PREFIX);
const marker = (ref: string, bytes: number) =>
  `${SPILL_PREFIX}${ref}] ${bytes} bytes moved off-context — call read_spilled({ ref: "${ref}" }) to view the full content.`;

// L3 toolResultBudget: when the combined size of tool_result bodies exceeds the
// budget, move the largest ones' full content to a SpillStore and leave a short
// retrievable marker in-context. Runs BEFORE micro so full content is preserved
// before micro would placeholder it. Edits text in place (keeps the block), so
// tool_call/tool_result pairing stays intact.
export function toolResultBudgetPass(opts: ToolResultBudgetOptions): CompactPass {
  const budget = opts.budgetBytes ?? 200_000;
  return {
    name: "toolResultBudget",
    async apply(messages) {
      const results: Array<{ mi: number; bi: number; bytes: number }> = [];
      let total = 0;
      messages.forEach((m, mi) => {
        if (Array.isArray(m.content)) {
          m.content.forEach((b, bi) => {
            if (b.type === "tool_result" && !isSpilled(b.content)) {
              results.push({ mi, bi, bytes: b.content.length });
              total += b.content.length;
            }
          });
        }
      });
      if (total <= budget) return messages;

      results.sort((a, b) => b.bytes - a.bytes);
      const spill = new Set<string>();
      for (const r of results) {
        if (total <= budget) break;
        spill.add(`${r.mi}:${r.bi}`);
        total -= r.bytes;
      }
      if (spill.size === 0) return messages;

      const output: Message[] = [];
      for (const [mi, message] of messages.entries()) {
        if (!Array.isArray(message.content)) { output.push(message); continue; }
        let changed = false;
        const content: ContentBlock[] = [];
        for (const [bi, block] of message.content.entries()) {
          if (block.type === "tool_result" && spill.has(`${mi}:${bi}`)) {
            const ref = await opts.store.put(block.content);
            content.push({ ...block, content: marker(ref, block.content.length) });
            changed = true;
          } else content.push(block);
        }
        output.push(changed ? { ...message, content } as Message : message);
      }
      return output;
    },
  };
}
