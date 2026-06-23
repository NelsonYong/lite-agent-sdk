import type { Message } from "../types";
import type { CompactPass } from "./types";

export interface SnipPassOptions {
  /** Only snip when the transcript exceeds this many messages. Default 50. */
  maxMessages?: number;
  /** How many leading turns to always keep. Default 1. */
  headTurns?: number;
  /** Keep trailing turns until at least this many messages are retained. Default 20. */
  tailKeep?: number;
}

// Split a flat message list into turns. A turn begins at a real user prompt
// (role:"user" with string content); tool_result messages and assistant replies
// stay attached to the turn that produced them — so a turn is a pairing-safe unit.
export function splitTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  let cur: Message[] = [];
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string" && cur.length > 0) {
      turns.push(cur);
      cur = [];
    }
    cur.push(m);
  }
  if (cur.length) turns.push(cur);
  return turns;
}

// L1 snipCompact: when over the message cap, drop whole middle turns and replace
// them with a single placeholder, keeping the head turn(s) and enough trailing
// turns. Cuts only on turn boundaries, so tool_call/tool_result pairs stay whole.
export function snipPass(opts: SnipPassOptions = {}): CompactPass {
  const maxMessages = opts.maxMessages ?? 50;
  const headTurns = opts.headTurns ?? 1;
  const tailKeep = opts.tailKeep ?? 20;
  return {
    name: "snip",
    apply(messages) {
      if (messages.length <= maxMessages) return messages;
      const turns = splitTurns(messages);

      let tailTurnCount = 0;
      let tailMsgCount = 0;
      for (let i = turns.length - 1; i >= 0 && tailMsgCount < tailKeep; i--) {
        tailMsgCount += turns[i]!.length;
        tailTurnCount++;
      }
      if (headTurns + tailTurnCount >= turns.length) return messages;

      const head = turns.slice(0, headTurns).flat();
      const tail = turns.slice(turns.length - tailTurnCount).flat();
      const omitted = turns.length - headTurns - tailTurnCount;
      const placeholder: Message = { role: "user", content: `[${omitted} earlier turn(s) omitted to save context]` };
      return [...head, placeholder, ...tail];
    },
  };
}
