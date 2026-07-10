import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";

const MAX_BYTES = 50_000;
const MAX_SNAPSHOT_BYTES = 1_000_000;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".next", ".lite-agent"]);

export function makeSafePath(workdir: string): (p: string) => string {
  const root = resolve(workdir);
  return (p: string): string => {
    const full = resolve(root, p);
    if (full !== root && !full.startsWith(root + "/")) {
      throw new Error(`Path escapes workspace: ${p}`);
    }
    return full;
  };
}

/** Bounded search for files named `base` under `root` — skips heavy/hidden dirs and
 *  caps depth, matches, and total entries scanned so it stays cheap on large repos. */
function findByBasename(root: string, base: string, cap = 5): string[] {
  const out: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let scanned = 0;
  while (stack.length && out.length < cap && scanned < 20_000) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      scanned++;
      if (e.isDirectory()) {
        if (depth < 8 && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
          stack.push({ dir: join(dir, e.name), depth: depth + 1 });
      } else if (e.name === base) {
        out.push(relative(root, join(dir, e.name)));
        if (out.length >= cap) break;
      }
    }
  }
  return out;
}

/** Turn a bare ENOENT into an actionable message: name the first path segment that
 *  doesn't exist, list the nearest existing directory, and suggest same-named files
 *  elsewhere in the workspace — so the model can correct a wrong path in one step
 *  instead of flailing. */
function notFoundHint(root: string, requested: string, full: string): string {
  const parts = relative(root, full).split(sep).filter(Boolean);
  let existing = root;
  let missing = full;
  for (const part of parts) {
    const candidate = join(existing, part);
    if (existsSync(candidate)) existing = candidate;
    else { missing = candidate; break; }
  }
  const missingRel = relative(root, missing) || requested;
  const existingRel = relative(root, existing) || ".";
  let listing: string[] = [];
  try { listing = readdirSync(existing).filter((n) => !n.startsWith(".")).slice(0, 30); } catch { /* ignore */ }
  const lines = [
    `File not found: ${requested}`,
    `Path "${missingRel}" does not exist. Nearest existing directory "${existingRel}" contains: ${listing.join(", ") || "(empty)"}.`,
  ];
  const base = parts[parts.length - 1];
  if (base) {
    const hits = findByBasename(root, base).filter((p) => p !== missingRel);
    if (hits.length)
      lines.push(`A file named "${base}" exists at: ${hits.join(", ")} (relative to the workspace root).`);
  }
  return lines.join("\n");
}

/** readFileSync, but ENOENT becomes the actionable hint. Other errors pass through. */
function readOrHint(root: string, requested: string, full: string): string {
  try {
    return readFileSync(full, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(notFoundHint(root, requested, full));
    throw e;
  }
}

/** statSync, but ENOENT becomes the same actionable hint used by read/edit. */
function statOrHint(root: string, requested: string, full: string): Stats {
  try {
    return statSync(full);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(notFoundHint(root, requested, full));
    throw e;
  }
}

export function fileTools(workdir: string): Tool[] {
  const root = resolve(workdir);
  const safePath = makeSafePath(workdir);

  const readFile = defineTool({
    name: "read_file",
    description:
      "Read a file's contents. `path` is relative to the workspace root (an absolute path inside the workspace also works). Pass the optional `limit` to cap how many lines are returned for large files. Prefer this over running cat/head/tail in bash.",
    schema: z.object({ path: z.string(), limit: z.number().int().optional() }),
    execute: ({ path, limit }) => {
      const lines = readOrHint(root, path, safePath(path)).split("\n");
      if (limit && limit < lines.length) {
        return [
          ...lines.slice(0, limit),
          `... (${lines.length - limit} more lines)`,
        ]
          .join("\n")
          .slice(0, MAX_BYTES);
      }
      return lines.join("\n").slice(0, MAX_BYTES);
    },
  });

  const writeFile = defineTool({
    name: "write_file",
    description:
      "Create or overwrite a file. `path` is relative to the workspace root (an absolute path inside the workspace also works); parent directories are created automatically. Prefer this over shell redirection in bash.",
    schema: z.object({ path: z.string(), content: z.string() }),
    execute: ({ path, content }, ctx) => {
      const fp = safePath(path);
      if (ctx.recordSnapshot) {
        if (!existsSync(fp)) ctx.recordSnapshot(path, null);
        else if (statSync(fp).size > MAX_SNAPSHOT_BYTES) ctx.recordSnapshot(path, null, true);
        else ctx.recordSnapshot(path, readFileSync(fp, "utf8"));
      }
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content);
      return `Wrote ${content.length} bytes to ${path}`;
    },
  });

  const editFile = defineTool({
    name: "edit_file",
    description:
      "Replace the first exact occurrence of `old_text` with `new_text` in a file. `path` is relative to the workspace root (an absolute path inside the workspace also works). Prefer this over editing files with sed/awk in bash.",
    schema: z.object({
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
    }),
    execute: ({ path, old_text, new_text }, ctx) => {
      const fp = safePath(path);
      const content = readOrHint(root, path, fp);
      if (!content.includes(old_text))
        return `Error: Text not found in ${path}`;
      if (ctx.recordSnapshot) {
        if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) ctx.recordSnapshot(path, null, true);
        else ctx.recordSnapshot(path, content);
      }
      writeFileSync(fp, content.replace(old_text, new_text));
      return `Edited ${path}`;
    },
  });

  const deleteFile = defineTool({
    name: "delete_file",
    description:
      "Delete a file. `path` is relative to the workspace root (an absolute path inside the workspace also works). When session checkpointing is enabled, files within the snapshot size limit are captured before deletion so `restore()` can recreate them. Prefer this over rm in bash.",
    schema: z.object({ path: z.string() }),
    execute: ({ path }, ctx) => {
      const fp = safePath(path);
      const size = statOrHint(root, path, fp).size;
      if (ctx.recordSnapshot) {
        if (size > MAX_SNAPSHOT_BYTES) ctx.recordSnapshot(path, null, true);
        else ctx.recordSnapshot(path, readFileSync(fp, "utf8"));
      }
      unlinkSync(fp);
      return `Deleted ${path}`;
    },
  });

  return [readFile, writeFile, editFile, deleteFile];
}
