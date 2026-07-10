import { expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@lite-agent/core";
import { atomicWriteFile, fileTools, makeSafePath } from "../src/tools/file";

const ctx: ToolContext = {
  sessionId: "s",
  signal: new AbortController().signal,
  emit: () => {},
};

test("read/write/edit operate within the workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-"));
  const [read, write, edit] = fileTools(dir);
  expect(
    await write!.execute({ path: "a.txt", content: "hello" }, ctx),
  ).toContain("Wrote");
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello");
  expect(await read!.execute({ path: "a.txt" }, ctx)).toBe("hello");
  await edit!.execute(
    { path: "a.txt", old_text: "hello", new_text: "bye" },
    ctx,
  );
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("bye");
});

test("write_file/edit_file record pre-mutation snapshots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-snap-"));
  const [, write, edit] = fileTools(dir);
  const snaps: { p: string; b: string | null; t?: boolean }[] = [];
  const snapCtx: ToolContext = { ...ctx, recordSnapshot: (p, b, t) => { snaps.push({ p, b, t }); } };

  await write!.execute({ path: "n.txt", content: "v1" }, snapCtx); // new file → before null
  await edit!.execute({ path: "n.txt", old_text: "v1", new_text: "v2" }, snapCtx); // → before "v1"

  expect(snaps).toEqual([
    { p: "n.txt", b: null, t: undefined },
    { p: "n.txt", b: "v1", t: undefined },
  ]);
});

test("delete_file removes a file and records its pre-delete snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-delete-"));
  const [, , , remove] = fileTools(dir);
  writeFileSync(join(dir, "old.txt"), "keep me");
  const snaps: { p: string; b: string | null; t?: boolean }[] = [];
  const snapCtx: ToolContext = { ...ctx, recordSnapshot: (p, b, t) => { snaps.push({ p, b, t }); } };

  expect(await remove!.execute({ path: "old.txt" }, snapCtx)).toBe("Deleted old.txt");
  expect(existsSync(join(dir, "old.txt"))).toBe(false);
  expect(snaps).toEqual([{ p: "old.txt", b: "keep me", t: undefined }]);
});

test("read_file returns an actionable hint for a wrong path (not a raw ENOENT)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-hint-"));
  mkdirSync(join(dir, "src", "agent"), { recursive: true });
  writeFileSync(join(dir, "src", "agent", "forge-agent.ts"), "x");
  mkdirSync(join(dir, "extension"), { recursive: true });
  writeFileSync(join(dir, "extension", "package.json"), "{}");
  const [read] = fileTools(dir);

  // Model guessed a bogus `extension/` prefix; the real file is src/agent/forge-agent.ts.
  // The tool throws synchronously; the try/catch handles both sync-throw and async-reject.
  let msg = "";
  try {
    await read!.execute({ path: "extension/src/agent/forge-agent.ts" }, ctx);
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toContain("File not found"); // actionable, not a raw ENOENT
  expect(msg).toContain("extension/src"); // names the first path segment that doesn't exist
  expect(msg).toContain("package.json"); // lists the nearest existing dir (extension/)
  expect(msg).toContain("src/agent/forge-agent.ts"); // suggests the real location by basename
});

test("edit_file returns the same actionable hint for a missing file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-hint2-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "hi");
  const [, , edit] = fileTools(dir);
  let msg = "";
  try {
    await edit!.execute({ path: "lib/a.ts", old_text: "hi", new_text: "yo" }, ctx);
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toContain("File not found");
  expect(msg).toContain("src/a.ts"); // suggests the real location
});

test("safePath blocks escaping the workspace", () => {
  const safe = makeSafePath("/tmp/work");
  expect(() => safe("../etc/passwd")).toThrow(/escapes workspace/);
  expect(safe("sub/a.txt")).toBe("/tmp/work/sub/a.txt");
});

test("read follows only in-workspace symlinks while mutations reject symlink paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-link-"));
  const outside = mkdtempSync(join(tmpdir(), "la-outside-"));
  writeFileSync(join(dir, "target.txt"), "inside");
  writeFileSync(join(outside, "secret.txt"), "outside");
  symlinkSync("target.txt", join(dir, "inside-link.txt"));
  symlinkSync(join(outside, "secret.txt"), join(dir, "outside-link.txt"));
  const [read, write, , remove] = fileTools(dir);

  expect(await read!.execute({ path: "inside-link.txt" }, ctx)).toBe("inside");
  expect(() => read!.execute({ path: "outside-link.txt" }, ctx)).toThrow(/escapes workspace/);
  await expect(Promise.resolve(write!.execute({ path: "inside-link.txt", content: "changed" }, ctx))).rejects.toThrow(/Symlink paths/);
  await expect(Promise.resolve(remove!.execute({ path: "inside-link.txt" }, ctx))).rejects.toThrow(/Symlink paths/);
  expect(readFileSync(join(dir, "target.txt"), "utf8")).toBe("inside");
});

test("mutations reject dangling symlinks before a non-atomic write can follow them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-dangling-link-"));
  const outside = mkdtempSync(join(tmpdir(), "la-dangling-outside-"));
  symlinkSync(join(outside, "created.txt"), join(dir, "link.txt"));
  const [, write] = fileTools(dir, { atomicWrites: false });

  await expect(Promise.resolve(write!.execute({ path: "link.txt", content: "escape" }, ctx))).rejects.toThrow(/Symlink paths/);
  expect(existsSync(join(outside, "created.txt"))).toBe(false);
});

test("atomic writes preserve file permissions and clean temporary files on rename failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "la-atomic-mode-"));
  const file = join(dir, "executable.sh");
  writeFileSync(file, "old");
  chmodSync(file, 0o751);
  atomicWriteFile(file, "new");
  expect(statSync(file).mode & 0o777).toBe(0o751);

  const targetDir = join(dir, "target");
  mkdirSync(targetDir);
  expect(() => atomicWriteFile(targetDir, "cannot replace a directory")).toThrow();
  expect(readdirSync(dir).filter((name) => name.startsWith(".target.") && name.endsWith(".tmp"))).toEqual([]);
});

test("write_file waits for durable snapshot recording and leaves no temporary file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-atomic-"));
  writeFileSync(join(dir, "a.txt"), "old");
  const [, write] = fileTools(dir);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const snapCtx: ToolContext = { ...ctx, recordSnapshot: async () => gate };

  const pending = Promise.resolve(write!.execute({ path: "a.txt", content: "new" }, snapCtx));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("old");
  release();
  await pending;
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("new");
  expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("delete_file records binary snapshots as base64", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-binary-"));
  const body = Buffer.from([0, 255, 1, 2, 3]);
  writeFileSync(join(dir, "data.bin"), body);
  const [, , , remove] = fileTools(dir);
  const snapshots: Array<{ before: string | null; encoding?: string }> = [];
  const snapCtx: ToolContext = {
    ...ctx,
    recordSnapshot: (_path, before, _truncated, encoding) => { snapshots.push({ before, encoding }); },
  };
  await remove!.execute({ path: "data.bin" }, snapCtx);
  expect(snapshots).toEqual([{ before: body.toString("base64"), encoding: "base64" }]);
});
