import type { Message } from "../types";

// A single compaction "brick": a pure transform over the message list. Returns
// the SAME array reference when it changes nothing (so callers can cheaply
// detect no-ops and stay idempotent). Compose bricks with runPipeline.
export interface CompactPass {
  readonly name: string;
  apply(messages: Message[]): Message[];
}

// Pipeline data-flow: feed messages through each pass in order, output of one
// becoming the input of the next. Order matters (cheap/structural first).
export function runPipeline(passes: CompactPass[], messages: Message[]): Message[] {
  return passes.reduce((msgs, pass) => pass.apply(msgs), messages);
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
