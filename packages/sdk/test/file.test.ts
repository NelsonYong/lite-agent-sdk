import { expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@lite-agent/core";
import { fileTools, makeSafePath } from "../src/tools/file";

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
  const snapCtx: ToolContext = { ...ctx, recordSnapshot: (p, b, t) => snaps.push({ p, b, t }) };

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
  const snapCtx: ToolContext = { ...ctx, recordSnapshot: (p, b, t) => snaps.push({ p, b, t }) };

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
