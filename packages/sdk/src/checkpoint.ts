import { storageDirectory } from "./storageFiles";
import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync,
  readdirSync, statSync, unlinkSync, writeFileSync, constants,
} from "node:fs";
import { lock } from "proper-lockfile";
import { atomicWriteFile } from "./tools/file";
import { storageEncoding, StorageError } from "./storage";
import type { StorageEncoding } from "./storage";
import type { Checkpointer, StoredEvent, SessionInfo } from "@lite-agent/core";
import { storeEvents, CheckpointConflictError } from "@lite-agent/core";

export interface FileCheckpointerOptions extends StorageEncoding {
  /** Directory holding one append-only `<sessionId>.jsonl` event log per session. */
  dir: string;
  /** Repair a malformed plaintext tail only. Encoded records always fail closed. */
  repairTail?: boolean;
  /** fsync each append before it is acknowledged. */
  durable?: boolean;
}

const SUFFIX = ".jsonl";
const sessionFileName = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new StorageError("File session ids must contain only letters, digits, underscores or hyphens");
  return id + SUFFIX;
};

/** Append-only event log. Locks cover read/check/encode/write, including async codecs. */
export function fileCheckpointer(opts: FileCheckpointerOptions): Checkpointer {
  const encoding = storageEncoding(opts);
  const safe = storageDirectory(opts.dir);
  const heads = new Map<string, { stamp: string; head: number }>();
  const stamp = (id: string): string => {
    if (!existsSync(fileFor(id))) return "missing";
    const info = statSync(fileFor(id), { bigint: true });
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  };
  const fileFor = (id: string) => safe(sessionFileName(id));
  const withLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const release = await lock(fileFor(id), { realpath: false, retries: { retries: 30, minTimeout: 5, maxTimeout: 100 } });
    try { return await fn(); } finally { await release(); }
  };
  const linesOf = async (id: string): Promise<{ events: StoredEvent[]; lines: string[] }> => {
    const file = fileFor(id);
    if (!existsSync(file)) return { events: [], lines: [] };
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
    const events: StoredEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      // Decoding is deliberately outside tail repair: a wrong key is not corruption to delete.
      const text = await encoding.decode(lines[i]!, encoding.context("checkpoint", id, String(i + 1)));
      try {
        const event = JSON.parse(text) as StoredEvent;
        if (event.seq !== i + 1 || event.sessionId !== id || event.parentSeq !== (i === 0 ? null : i) || typeof event.event?.type !== "string")
          throw new Error("invalid StoredEvent shape");
        events.push(event);
      } catch {
        if (opts.codec || !opts.repairTail || i !== lines.length - 1)
          throw new StorageError(`Corrupt checkpoint record ${i + 1}`);
        lines.pop();
        atomicWriteFile(file, lines.length ? lines.join("\n") + "\n" : "", 0o600);
      }
    }
    return { events, lines };
  };
  const headOf = async (id: string): Promise<number> => {
    const current = stamp(id);
    const cached = heads.get(id);
    if (cached?.stamp === current) return cached.head;
    const head = (await linesOf(id)).events.at(-1)?.seq ?? 0;
    heads.set(id, { stamp: stamp(id), head });
    return head;
  };
  return {
    append: (sessionId, events, expectedHead) => withLock(sessionId, async () => {
      const head = await headOf(sessionId);
      if (expectedHead !== undefined && expectedHead !== head)
        throw new CheckpointConflictError(sessionId, expectedHead, head);
      const stored = storeEvents(sessionId, head, events);
      if (!stored.length) return head;
      const encoded: string[] = [];
      for (const event of stored)
        encoded.push(await encoding.encode(JSON.stringify(event), encoding.context("checkpoint", sessionId, String(event.seq))));
      // No file mutation until every event is encoded successfully.
      const fd = openSync(fileFor(sessionId), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(fd, encoded.join("\n") + "\n");
        if (opts.durable) fsyncSync(fd);
      } finally { closeSync(fd); }
      const newHead = stored.at(-1)!.seq;
      heads.set(sessionId, { stamp: stamp(sessionId), head: newHead });
      return newHead;
    }),
    async *read(sessionId, readOptions) {
      const { events } = await withLock(sessionId, () => linesOf(sessionId));
      for (const event of events) if (readOptions?.sinceSeq === undefined || event.seq > readOptions.sinceSeq) yield event;
    },
    head: (sessionId) => withLock(sessionId, () => headOf(sessionId)),
    async list(): Promise<SessionInfo[]> {
      return readdirSync(safe())
        .filter((f) => f.endsWith(SUFFIX))
        .map((f) => ({ id: f.slice(0, -SUFFIX.length), mtime: statSync(safe(f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    },
    delete: (sessionId) => withLock(sessionId, async () => {
      const file = fileFor(sessionId);
      if (existsSync(file)) unlinkSync(file);
      heads.delete(sessionId);
    }),
    truncate: (sessionId, toSeq, expectedHead) => withLock(sessionId, async () => {
      const { events, lines } = await linesOf(sessionId);
      const actual = events.at(-1)?.seq ?? 0;
      if (expectedHead !== undefined && expectedHead !== actual)
        throw new CheckpointConflictError(sessionId, expectedHead, actual);
      if (!Number.isSafeInteger(toSeq) || toSeq < 0 || toSeq > actual) throw new RangeError("Invalid checkpoint sequence");
      if (!existsSync(fileFor(sessionId))) return;
      const kept = lines.slice(0, toSeq);
      heads.delete(sessionId);
      // Retain original encoded records; never decode/re-encode to truncate.
      atomicWriteFile(fileFor(sessionId), kept.length ? kept.join("\n") + "\n" : "", 0o600);
    }),
  };
}
