import { expect, test } from "vitest";
import type { ToolContext } from "@lite-agent/core";
import { noopSandbox } from "@lite-agent/core";
import { bashTool } from "../src/tools/bash";
import { todoTool } from "../src/tools/todo";
import { defaultTools } from "../src/tools";

const ctx: ToolContext = { sessionId: "s", signal: new AbortController().signal, emit: () => {} };

test("bash runs commands and blocks dangerous ones", async () => {
  const bash = bashTool(process.cwd());
  expect(await bash.execute({ command: "echo hi" }, ctx)).toBe("hi");
  expect(await bash.execute({ command: "sudo rm -rf x" }, ctx)).toMatch(/Dangerous/);
});

test("todo renders items and enforces a single in_progress", async () => {
  const todo = todoTool();
  const out = await todo.execute({ items: [{ id: "1", text: "a", status: "in_progress" }] }, ctx);
  expect(out).toContain("[>] #1: a");
  await expect(
    todo.execute({ items: [
      { id: "1", text: "a", status: "in_progress" },
      { id: "2", text: "b", status: "in_progress" },
    ] }, ctx),
  ).rejects.toThrow(/in_progress/);
});

test("defaultTools exposes the five built-ins by name", () => {
  const names = defaultTools(process.cwd()).map((t) => t.name).sort();
  expect(names).toEqual(["bash", "edit_file", "read_file", "todo", "write_file"]);
});

test("bash wraps the command via ctx.sandbox before executing", async () => {
  const sandboxCtx = {
    sessionId: "s",
    signal: new AbortController().signal,
    emit: () => {},
    sandbox: { id: "fake", wrap: (c: string) => `echo [${c}]` },
  };
  const out = await bashTool(process.cwd()).execute({ command: "hi" }, sandboxCtx);
  expect(out).toBe("[hi]");
});

test("bash runs the command unchanged under noopSandbox", async () => {
  const noopCtx = { sessionId: "s", signal: new AbortController().signal, emit: () => {}, sandbox: noopSandbox() };
  expect(await bashTool(process.cwd()).execute({ command: "echo plain" }, noopCtx)).toBe("plain");
});
