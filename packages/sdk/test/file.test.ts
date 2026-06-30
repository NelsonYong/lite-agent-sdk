import { expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
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

test("safePath blocks escaping the workspace", () => {
  const safe = makeSafePath("/tmp/work");
  expect(() => safe("../etc/passwd")).toThrow(/escapes workspace/);
  expect(safe("sub/a.txt")).toBe("/tmp/work/sub/a.txt");
});
