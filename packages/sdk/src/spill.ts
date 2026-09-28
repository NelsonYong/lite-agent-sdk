import { storageDirectory } from "./storageFiles";
import { storageEncoding } from "./storage";
import type { StorageEncoding } from "./storage";
import { atomicWriteFile } from "./tools/file";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { SpillStore, Tool } from "@lite-agent/core";

export interface FileSpillStoreOptions extends StorageEncoding {
  /** Directory holding one `<ref>.txt` blob per spilled tool result. */
  dir: string;
}

// Filesystem SpillStore: content-addressed (sha1) so identical bodies dedup and
// refs are stable. Encoding finishes before the blob is committed.
export function fileSpillStore(opts: FileSpillStoreOptions): SpillStore {
  const encoding = storageEncoding(opts);
  const safe = storageDirectory(opts.dir);
  const fileFor = (ref: string) => safe(`${ref}.txt`);
  return {
    async put(content) {
      const ref = createHash("sha1").update(content).digest("hex").slice(0, 16);
      const encoded = await encoding.encode(content, encoding.context("spill", "project", ref));
      atomicWriteFile(fileFor(ref), encoded, 0o600);
      return ref;
    },
    async get(ref) {
      if (!/^[a-f0-9]{16}$/.test(ref)) return null;
      const file = fileFor(ref);
      return existsSync(file) ? encoding.decode(readFileSync(file, "utf8"), encoding.context("spill", "project", ref)) : null;
    },
  };
}

// The retrieval side of L3: lets the agent pull a spilled tool result back into
// context on demand, using the ref shown in its [spilled:<ref>] marker.
export function readSpilledTool(store: SpillStore): Tool {
  return defineTool({
    name: "read_spilled",
    description:
      "Retrieve the full content of a tool result that was moved off-context to save space. Pass the ref shown in its [spilled:<ref>] marker.",
    schema: z.object({ ref: z.string() }),
    security: { network: "none", filesystem: "unrestricted", sideEffects: "none" },
    execute: async ({ ref }) => (await store.get(ref)) ?? `No spilled content for ref '${ref}'`,
  });
}
