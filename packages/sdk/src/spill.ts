import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { SpillStore, Tool } from "@lite-agent/core";

export interface FileSpillStoreOptions {
  /** Directory holding one `<ref>.txt` blob per spilled tool result. */
  dir: string;
}

// Filesystem SpillStore: content-addressed (sha1) so identical bodies dedup and
// refs are stable. Sync fs so it composes inside the CompactPass pipeline.
export function fileSpillStore(opts: FileSpillStoreOptions): SpillStore {
  const fileFor = (ref: string) => join(opts.dir, `${ref.replace(/[^a-f0-9]/gi, "")}.txt`);
  return {
    put(content) {
      mkdirSync(opts.dir, { recursive: true });
      const ref = createHash("sha1").update(content).digest("hex").slice(0, 16);
      writeFileSync(fileFor(ref), content);
      return ref;
    },
    get(ref) {
      const file = fileFor(ref);
      return existsSync(file) ? readFileSync(file, "utf8") : null;
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
    execute: ({ ref }) => store.get(ref) ?? `No spilled content for ref '${ref}'`,
  });
}
