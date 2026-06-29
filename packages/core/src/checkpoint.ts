import type { AssistantMessage, Message, ToolResultBlock } from "./types";
import { CheckpointConflictError } from "./events";

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

/** The persistence seam. Backend-agnostic; the evolution of the `Store` strategy. */
export interface Checkpointer {
  /** Append events; returns the new head seq. If `expectedHead` is given and the
   *  current head differs, throws CheckpointConflictError (optimistic concurrency). */
  append(sessionId: string, events: SessionEvent[], expectedHead?: number): Promise<number>;
  /** Replay events in seq order, optionally from `sinceSeq` (exclusive). */
  read(sessionId: string, opts?: { sinceSeq?: number }): AsyncIterable<StoredEvent>;
  /** Current head seq (0 when empty/unknown). */
  head(sessionId: string): Promise<number>;
  /** Known sessions, most-recent first. */
  list(): Promise<SessionInfo[]>;
  /** Delete a session's entire log. */
  delete(sessionId: string): Promise<void>;
}

/** Build StoredEvents for `events` starting after `fromSeq`. */
export function storeEvents(sessionId: string, fromSeq: number, events: SessionEvent[]): StoredEvent[] {
  const ts = new Date().toISOString();
  return events.map((event, i) => {
    const seq = fromSeq + i + 1;
    return { seq, sessionId, parentSeq: seq === 1 ? null : seq - 1, ts, event };
  });
}

/** In-memory Checkpointer (testing/ephemeral). */
export function memoryCheckpointer(): Checkpointer {
  const logs = new Map<string, StoredEvent[]>();
  const updated = new Map<string, number>();
  return {
    async append(sessionId, events, expectedHead) {
      const log = logs.get(sessionId) ?? [];
      const head = log.length ? log[log.length - 1]!.seq : 0;
      if (expectedHead !== undefined && expectedHead !== head)
        throw new CheckpointConflictError(sessionId, expectedHead, head);
      const stored = storeEvents(sessionId, head, events);
      log.push(...stored);
      logs.set(sessionId, log);
      updated.set(sessionId, Date.now());
      return log.length ? log[log.length - 1]!.seq : head;
    },
    async *read(sessionId, opts) {
      const log = logs.get(sessionId) ?? [];
      for (const e of log) if (opts?.sinceSeq === undefined || e.seq > opts.sinceSeq) yield e;
    },
    async head(sessionId) {
      const log = logs.get(sessionId);
      return log && log.length ? log[log.length - 1]!.seq : 0;
    },
    async list() {
      return [...logs.keys()]
        .map((id) => ({ id, mtime: updated.get(id) ?? 0 }))
        .sort((a, b) => b.mtime - a.mtime);
    },
    async delete(sessionId) {
      logs.delete(sessionId);
      updated.delete(sessionId);
    },
  };
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
