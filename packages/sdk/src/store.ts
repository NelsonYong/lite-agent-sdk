import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store, Message } from "@lite-agent/core";

export interface JsonlStoreOptions {
  /** Directory holding one `<sessionId>.jsonl` transcript per session. */
  dir: string;
}

// Filesystem Store: each session is a JSONL file (one Message per line) under
// `dir`, so transcripts survive process restarts (resume). The id is sanitized
// to a flat filename so a traversal-style id can't escape `dir`.
export function jsonlStore(opts: JsonlStoreOptions): Store {
  const fileFor = (id: string) => join(opts.dir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
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
  };
}
