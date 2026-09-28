import type { Message } from "../types";

// Sentinel that prefixes a spilled tool_result's in-context marker. Shared so
// micro can recognize an already-spilled block and leave its ref intact.
export const SPILL_PREFIX = "[spilled:";

// A single compaction "brick": a transform over the message list. Returns
// the SAME array reference when it changes nothing (so callers can cheaply
// detect no-ops and stay idempotent). Compose bricks with runPipeline.
export interface CompactPass {
  readonly name: string;
  apply(messages: Message[]): Message[] | Promise<Message[]>;
}

// Pipeline data-flow: feed messages through each pass in order, output of one
// becoming the input of the next. Order matters (cheap/structural first).
export async function runPipeline(passes: CompactPass[], messages: Message[]): Promise<Message[]> {
  let result = messages;
  for (const pass of passes) result = await pass.apply(result);
  return result;
}

// Rough token estimate (~chars/4) over all textual payloads. Used for the
// before/after numbers on the compaction event and (later) trigger thresholds.
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "tool_result") chars += b.content.length;
      else if (b.type === "tool_call") chars += JSON.stringify(b.input).length;
    }
  }
  return Math.ceil(chars / 4);
}
