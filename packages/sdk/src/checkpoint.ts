import { mkdirSync, readFileSync, existsSync, appendFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Checkpointer, SessionEvent, StoredEvent, SessionInfo } from "@lite-agent/core";
import { storeEvents, CheckpointConflictError } from "@lite-agent/core";

export interface FileCheckpointerOptions {
  /** Directory holding one append-only `<sessionId>.jsonl` event log per session. */
  dir: string;
}

const SUFFIX = ".jsonl";
const sanitize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * Append-only file Checkpointer: one `StoredEvent` per line. Head is cached in
 * memory (read from disk on first touch). Suitable for single-process/local use;
 * cross-process concurrency is the SQLite backend's job.
 */
export function fileCheckpointer(opts: FileCheckpointerOptions): Checkpointer {
  const heads = new Map<string, number>();
  const fileFor = (id: string) => join(opts.dir, sanitize(id) + SUFFIX);
  const linesOf = (id: string): StoredEvent[] => {
    const file = fileFor(id);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as StoredEvent);
  };
  const headOf = (id: string): number => {
    const cached = heads.get(id);
    if (cached !== undefined) return cached;
    const lines = linesOf(id);
    const head = lines.length ? lines[lines.length - 1]!.seq : 0;
    heads.set(id, head);
    return head;
  };
  return {
    async append(sessionId, events, expectedHead) {
      const head = headOf(sessionId);
      if (expectedHead !== undefined && expectedHead !== head)
        throw new CheckpointConflictError(sessionId, expectedHead, head);
      const stored = storeEvents(sessionId, head, events);
      mkdirSync(opts.dir, { recursive: true });
      appendFileSync(fileFor(sessionId), stored.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const newHead = stored.length ? stored[stored.length - 1]!.seq : head;
      heads.set(sessionId, newHead);
      return newHead;
    },
    async *read(sessionId, opts2) {
      for (const e of linesOf(sessionId)) if (opts2?.sinceSeq === undefined || e.seq > opts2.sinceSeq) yield e;
    },
    async head(sessionId) {
      return headOf(sessionId);
    },
    async list(): Promise<SessionInfo[]> {
      if (!existsSync(opts.dir)) return [];
      return readdirSync(opts.dir)
        .filter((f) => f.endsWith(SUFFIX))
        .map((f) => ({ id: f.slice(0, -SUFFIX.length), mtime: statSync(join(opts.dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    },
    async delete(sessionId) {
      const file = fileFor(sessionId);
      if (existsSync(file)) unlinkSync(file);
      heads.delete(sessionId);
    },
  };
}
