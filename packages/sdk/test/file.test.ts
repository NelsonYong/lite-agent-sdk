import { expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@lite-agent-sdk/core";
import { fileTools, makeSafePath } from "../src/tools/file";

const ctx: ToolContext = { sessionId: "s", signal: new AbortController().signal, emit: () => {} };

test("read/write/edit operate within the workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-"));
  const [read, write, edit] = fileTools(dir);
  expect(await write!.execute({ path: "a.txt", content: "hello" }, ctx)).toContain("Wrote");
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello");
  expect(await read!.execute({ path: "a.txt" }, ctx)).toBe("hello");
  await edit!.execute({ path: "a.txt", old_text: "hello", new_text: "bye" }, ctx);
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("bye");
});

test("safePath blocks escaping the workspace", () => {
  const safe = makeSafePath("/tmp/work");
  expect(() => safe("../etc/passwd")).toThrow(/escapes workspace/);
  expect(safe("sub/a.txt")).toBe("/tmp/work/sub/a.txt");
});
