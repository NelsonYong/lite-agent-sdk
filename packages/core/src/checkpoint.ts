import type { AssistantMessage, Message, ToolResultBlock } from "./types";
import type { Store } from "./strategies";
import { CheckpointConflictError } from "./events";

/** One appended fact about a session. The canonical persisted unit. */
export type SessionEvent =
  | { type: "user"; message: Message }
  | { type: "assistant"; message: AssistantMessage }
  | { type: "tool_result"; result: ToolResultBlock; turn: number }
  | { type: "file_snapshot"; path: string; before: string | null; truncated?: boolean; turn: number };

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
 * Wrap a legacy whole-array `Store` as a `Checkpointer`, so code that injected a
 * custom Store keeps working. `append` folds the full state and re-saves it (the
 * original O(n) behavior — no per-event durability); `read` replays the saved
 * messages as synthetic `user`/`assistant` events. `head` is the message count.
 * `list` and `delete` delegate to the wrapped store when it provides those methods,
 * otherwise return []/no-op (a bare Store has no enumeration capability).
 * Caveat: appends write the wrapped store's legacy (no-`seq`) format; if that store
 * points under the swept `sessions/` tree, the cleanup sweeper will discard those
 * files as legacy.
 */
export function legacyStoreAdapter(store: Store): Checkpointer {
  const eventsOf = (messages: Message[]): SessionEvent[] =>
    messages.map((m) =>
      m.role === "assistant"
        ? { type: "assistant", message: m as AssistantMessage }
        : { type: "user", message: m },
    );
  // Track head per session so multiple appends within one run stay consistent even
  // when the wrapped Store's `load` does not round-trip (e.g. a write-only stub).
  const heads = new Map<string, number>();
  return {
    async append(sessionId, events, expectedHead) {
      const current = (await store.load(sessionId)) ?? [];
      const head = heads.get(sessionId) ?? current.length;
      if (expectedHead !== undefined && expectedHead !== head)
        throw new CheckpointConflictError(sessionId, expectedHead, head);
      const merged = [...current, ...foldEvents(events)];
      await store.save(sessionId, merged);
      const newHead = head + (merged.length - current.length);
      heads.set(sessionId, newHead);
      return newHead;
    },
    async *read(sessionId) {
      const messages = (await store.load(sessionId)) ?? [];
      yield* storeEvents(sessionId, 0, eventsOf(messages));
    },
    async head(sessionId) {
      const cached = heads.get(sessionId);
      return cached ?? ((await store.load(sessionId)) ?? []).length;
    },
    async list() {
      const s = store as Partial<{ list(): Promise<SessionInfo[]> }>;
      return typeof s.list === "function" ? s.list() : [];
    },
    async delete(sessionId) {
      const s = store as Partial<{ delete(id: string): Promise<void> }>;
      if (typeof s.delete === "function") await s.delete(sessionId);
    },
  };
}

/**
 * Rebuild conversation state from an event log. Consecutive `tool_result`
 * events coalesce into a single `{ role: "user", content: [blocks] }` message,
 * reproducing the kernel's turn shape (one user message per turn's results).
 */
export function foldEvents(events: SessionEvent[]): Message[] {
  let messages: Message[] = [];
  let pending: ToolResultBlock[] = [];
  const flush = () => {
    if (pending.length) { messages.push({ role: "user", content: pending }); pending = []; }
  };
  for (const ev of events) {
    switch (ev.type) {
      case "tool_result": pending.push(ev.result); break;
      case "user": case "assistant": flush(); messages.push(ev.message); break;
      // file_snapshot (and future sidecar events): not part of model context
    }
  }
  flush();
  return messages;
}
