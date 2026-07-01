import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store, Message, SessionInfo } from "@lite-agent/core";

export interface JsonlStoreOptions {
  /** Directory holding one `<sessionId>.jsonl` transcript per session. */
  dir: string;
}

export type { SessionInfo };

/** A Store that can also enumerate and delete its sessions. */
export interface SessionStore extends Store {
  list(): Promise<SessionInfo[]>;
  delete(id: string): Promise<void>;
}

const SUFFIX = ".jsonl";

// Filesystem Store: each session is a JSONL file (one Message per line) under
// `dir`, so transcripts survive process restarts (resume). The id is sanitized
// to a flat filename so a traversal-style id can't escape `dir`.
export function jsonlStore(opts: JsonlStoreOptions): SessionStore {
  const fileFor = (id: string) =>
    join(opts.dir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}${SUFFIX}`);
  return {
    async load(id) {
      const file = fileFor(id);
      if (!existsSync(file)) return null;
      return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Message);
    },
    async save(id, messages) {
      mkdirSync(opts.dir, { recursive: true });
      const body = messages.map((m) => JSON.stringify(m)).join("\n");
      writeFileSync(fileFor(id), messages.length ? body + "\n" : "");
    },
    async list() {
      if (!existsSync(opts.dir)) return [];
      return readdirSync(opts.dir)
        .filter((f) => f.endsWith(SUFFIX))
        .map((f) => ({
          id: f.slice(0, -SUFFIX.length),
          mtime: statSync(join(opts.dir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
    },
    async delete(id) {
      const file = fileFor(id);
      if (existsSync(file)) unlinkSync(file);
    },
  };
}

/** Unique session id — a UUID v4 (Claude Code-style), e.g. `be63a577-971d-4a42-a8fe-a572b7246431`.
 *  Replaces the old process-local counter. Session listing sorts by mtime, not by id. */
export function newSessionId(): string {
  return randomUUID();
}

/** True when a Store also supports session listing/deletion (e.g. jsonlStore). */
export function isSessionStore(store: Store | undefined): store is SessionStore {
  return (
    !!store &&
    typeof (store as Partial<SessionStore>).list === "function" &&
    typeof (store as Partial<SessionStore>).delete === "function"
  );
}
