import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { isUtf8 } from "node:buffer";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool, ToolContext } from "@lite-agent/core";

const MAX_BYTES = 50_000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".next", ".lite-agent"]);

export interface FileToolsOptions {
  /** Read symlinks only when their final target remains in the workspace. Mutations always reject them. */
  symlinks?: "inside" | "deny";
  /** Maximum pre-mutation snapshot size. Default 1 MiB. */
  maxSnapshotBytes?: number;
  /** Use same-directory fsync + rename for writes and edits. Default true. */
  atomicWrites?: boolean;
}

type PathMode = "read" | "write" | "delete";

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function lstatIfPresent(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Resolve existing components one by one so symlinks cannot bypass the workspace boundary. */
export function resolveSafePath(
  workdir: string,
  requested: string,
  opts: { mode?: PathMode; symlinks?: "inside" | "deny" } = {},
): string {
  const root = realpathSync(resolve(workdir));
  const lexical = resolve(root, requested);
  if (!isInside(root, lexical)) throw new Error(`Path escapes workspace: ${requested}`);
  const parts = relative(root, lexical).split(sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    const candidate = join(current, parts[i]!);
    const stat = lstatIfPresent(candidate);
    if (!stat) return join(candidate, ...parts.slice(i + 1));
    if (stat.isSymbolicLink()) {
      if (opts.mode !== "read" || opts.symlinks === "deny")
        throw new Error(`Symlink paths are not allowed for ${opts.mode ?? "write"}: ${requested}`);
      const target = realpathSync(candidate);
      if (!isInside(root, target)) throw new Error(`Symlink escapes workspace: ${requested}`);
      current = target;
    } else {
      current = candidate;
    }
    if (!isInside(root, current)) throw new Error(`Path escapes workspace: ${requested}`);
  }
  return current;
}

/** Legacy lexical resolver retained for callers; file tools use resolveSafePath. */
export function makeSafePath(workdir: string): (p: string) => string {
  const root = resolve(workdir);
  return (p: string): string => {
    const full = resolve(root, p);
    if (!isInside(root, full)) throw new Error(`Path escapes workspace: ${p}`);
    return full;
  };
}

/** Same-directory atomic replacement. Exported for restore and local integrations. */
export function atomicWriteFile(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const existingMode = existsSync(path) ? statSync(path).mode & 0o7777 : undefined;
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", existingMode ?? 0o666);
    if (existingMode !== undefined) chmodSync(temp, existingMode);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    try {
      const dirFd = openSync(dirname(path), "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* directory fsync is not supported on every platform */ }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

function findByBasename(root: string, base: string, cap = 5): string[] {
  const out: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let scanned = 0;
  while (stack.length && out.length < cap && scanned < 20_000) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      scanned++;
      if (entry.isDirectory()) {
        if (depth < 8 && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name))
          stack.push({ dir: join(dir, entry.name), depth: depth + 1 });
      } else if (entry.name === base) {
        out.push(relative(root, join(dir, entry.name)));
        if (out.length >= cap) break;
      }
    }
  }
  return out;
}

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
    if (hits.length) lines.push(`A file named "${base}" exists at: ${hits.join(", ")} (relative to the workspace root).`);
  }
  return lines.join("\n");
}

function readOrHint(root: string, requested: string, full: string): string {
  try { return readFileSync(full, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(notFoundHint(root, requested, full));
    throw error;
  }
}

function statOrHint(root: string, requested: string, full: string): Stats {
  try { return statSync(full); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(notFoundHint(root, requested, full));
    throw error;
  }
}

export function fileTools(workdir: string, opts: FileToolsOptions = {}): Tool[] {
  const root = resolve(workdir);
  const maxSnapshotBytes = opts.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES;
  const safePath = (path: string, mode: PathMode) =>
    resolveSafePath(workdir, path, { mode, symlinks: opts.symlinks ?? "inside" });
  const write = opts.atomicWrites === false ? writeFileSync : atomicWriteFile;
  const snapshot = async (path: string, fp: string, ctx: ToolContext) => {
    if (!ctx.recordSnapshot) return;
    if (!existsSync(fp)) { await ctx.recordSnapshot(path, null); return; }
    const size = statSync(fp).size;
    if (size > maxSnapshotBytes) { await ctx.recordSnapshot(path, null, true); return; }
    const body = readFileSync(fp);
    if (isUtf8(body)) await ctx.recordSnapshot(path, body.toString("utf8"), undefined, "utf8");
    else await ctx.recordSnapshot(path, body.toString("base64"), undefined, "base64");
  };

  const readFile = defineTool({
    name: "read_file",
    description:
      "Read a file's contents. `path` is relative to the workspace root (an absolute path inside the workspace also works). Pass the optional `limit` to cap how many lines are returned for large files. Prefer this over running cat/head/tail in bash.",
    schema: z.object({ path: z.string(), limit: z.number().int().optional() }),
    security: { network: "none", filesystem: "workspace", sideEffects: "none" },
    execute: ({ path, limit }) => {
      const lines = readOrHint(root, path, safePath(path, "read")).split("\n");
      if (limit && limit < lines.length) {
        return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`]
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
    security: { network: "none", filesystem: "workspace", sideEffects: "workspace" },
    execute: async ({ path, content }, ctx) => {
      const fp = safePath(path, "write");
      await snapshot(path, fp, ctx);
      write(fp, content);
      return `Wrote ${content.length} bytes to ${path}`;
    },
  });

  const editFile = defineTool({
    name: "edit_file",
    description:
      "Replace the first exact occurrence of `old_text` with `new_text` in a file. `path` is relative to the workspace root (an absolute path inside the workspace also works). Prefer this over editing files with sed/awk in bash.",
    schema: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
    security: { network: "none", filesystem: "workspace", sideEffects: "workspace" },
    execute: async ({ path, old_text, new_text }, ctx) => {
      const fp = safePath(path, "write");
      const content = readOrHint(root, path, fp);
      if (!content.includes(old_text)) return `Error: Text not found in ${path}`;
      await snapshot(path, fp, ctx);
      write(fp, content.replace(old_text, new_text));
      return `Edited ${path}`;
    },
  });

  const deleteFile = defineTool({
    name: "delete_file",
    description:
      "Delete a file. `path` is relative to the workspace root (an absolute path inside the workspace also works). When session checkpointing is enabled, files within the snapshot size limit are captured before deletion so `restore()` can recreate them. Prefer this over rm in bash.",
    schema: z.object({ path: z.string() }),
    security: { network: "none", filesystem: "workspace", sideEffects: "workspace" },
    execute: async ({ path }, ctx) => {
      const fp = safePath(path, "delete");
      const stat = statOrHint(root, path, fp);
      if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);
      await snapshot(path, fp, ctx);
      unlinkSync(fp);
      return `Deleted ${path}`;
    },
  });

  return [readFile, writeFile, editFile, deleteFile];
}
