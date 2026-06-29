import type { AssistantMessage, Message, ToolResultBlock } from "./types";

/** One appended fact about a session. The canonical persisted unit. */
export type SessionEvent =
  | { type: "user"; message: Message }
  | { type: "assistant"; message: AssistantMessage }
  | { type: "tool_result"; result: ToolResultBlock; turn: number };

/** A SessionEvent as stored, with its monotonic seq and parent link. */
export type StoredEvent = {
  seq: number;
  sessionId: string;
  parentSeq: number | null;
  ts: string;
  event: SessionEvent;
};

/** Lightweight metadata for one persisted session. */
export interface SessionInfo {
  id: string;
  mtime: number; // ms since epoch, most-recent activity
}

/**
 * Rebuild conversation state from an event log. Consecutive `tool_result`
 * events coalesce into a single `{ role: "user", content: [blocks] }` message,
 * reproducing the kernel's turn shape (one user message per turn's results).
 */
export function foldEvents(events: SessionEvent[]): Message[] {
  const messages: Message[] = [];
  let pending: ToolResultBlock[] = [];
  const flush = () => {
    if (pending.length) {
      messages.push({ role: "user", content: pending });
      pending = [];
    }
  };
  for (const ev of events) {
    if (ev.type === "tool_result") {
      pending.push(ev.result);
      continue;
    }
    flush();
    messages.push(ev.message);
  }
  flush();
  return messages;
}
