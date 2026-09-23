import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { HOOK_NAMES } from "./types";
import type { CommandHook, HookName } from "./types";

const command = z.object({
  command: z.string().trim().min(1),
  timeoutMs: z.number().int().min(1).max(120_000).default(10_000),
  match: z.string().min(1).optional(),
}).strict();
const document = z.object({
  version: z.literal(1),
  hooks: z.object(Object.fromEntries(HOOK_NAMES.map((name) => [name, z.array(command).optional()]))).strict(),
}).strict();

/** Snapshot both files once at root construction; repository edits cannot hot-load code. */
export function loadHookFiles(home: string, workdir: string): CommandHook[] {
  const hooks: CommandHook[] = [];
  const visited = new Set<string>();
  for (const [source, file] of [
    ["global", join(resolve(home), "hooks.json")],
    ["project", join(resolve(workdir), ".lite-agent", "hooks.json")],
  ] as const) {
    if (!existsSync(file)) continue;
    const real = realpathSync(file);
    if (visited.has(real)) continue;
    visited.add(real);
    try {
      if (statSync(file).size > 256 * 1024) throw new Error("configuration exceeds 256 KiB");
      const parsed = document.parse(JSON.parse(readFileSync(file, "utf8")));
      for (const [event, entries] of Object.entries(parsed.hooks)) {
        for (const entry of entries ?? []) {
          if (entry.match && !event.startsWith("tool:")) throw new Error("match is only valid for tool events");
          hooks.push({ ...entry, event: event as HookName, source, file });
        }
      }
    } catch (error) {
      throw new Error(`Invalid hooks configuration ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return hooks;
}
