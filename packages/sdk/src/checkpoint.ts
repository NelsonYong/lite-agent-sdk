import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Checkpointer, SessionEvent, StoredEvent, SessionInfo } from "@lite-agent/core";
import { storeEvents, CheckpointConflictError } from "@lite-agent/core";

export interface FileCheckpointerOptions {
  /** Directory holding one append-only `<sessionId>.jsonl` event log per session. */
  dir: string;
  /** Truncate one malformed final record, preserving every complete prior event. */
  repairTail?: boolean;
  /** fsync each append before it is acknowledged. */
  durable?: boolean;
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
    const lines = readFileSync(file, "utf8").split("\n");
    const parsed: StoredEvent[] = [];
    const nonEmpty = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim() !== "");
    for (let i = 0; i < nonEmpty.length; i++) {
      const { line, index } = nonEmpty[i]!;
      try {
        const event = JSON.parse(line) as StoredEvent;
        if (!Number.isInteger(event.seq) || event.seq <= 0 || typeof event.event?.type !== "string")
          throw new Error("invalid StoredEvent shape");
        parsed.push(event);
      } catch (error) {
        const isTail = i === nonEmpty.length - 1;
        if (!opts.repairTail || !isTail)
          throw new Error(`Corrupt checkpoint record ${index + 1} in ${file}: ${(error as Error).message}`);
        writeFileSync(file, parsed.length ? parsed.map((event) => JSON.stringify(event)).join("\n") + "\n" : "");
      }
    }
    return parsed;
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
      const body = stored.map((e) => JSON.stringify(e)).join("\n") + "\n";
      if (opts.durable) {
        const fd = openSync(fileFor(sessionId), "a");
        try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
      } else {
        appendFileSync(fileFor(sessionId), body);
      }
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
    async truncate(sessionId, toSeq) {
      if (!existsSync(fileFor(sessionId))) return; // unknown session: no-op (don't create a phantom file)
      const kept = linesOf(sessionId).filter((e) => e.seq <= toSeq);
      mkdirSync(opts.dir, { recursive: true });
      writeFileSync(
        fileFor(sessionId),
        kept.length ? kept.map((e) => JSON.stringify(e)).join("\n") + "\n" : "",
      );
      heads.set(sessionId, kept.length ? kept[kept.length - 1]!.seq : 0);
    },
  };
}
