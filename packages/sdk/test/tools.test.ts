import { expect, test } from "vitest";
import type { ToolContext } from "@lite-agent/core";
import { noopSandbox } from "@lite-agent/core";
import { bashTool } from "../src/tools/bash";
import { defaultTools } from "../src/tools";

const ctx: ToolContext = {
  sessionId: "s",
  signal: new AbortController().signal,
  emit: () => {},
};

test("bash runs commands and blocks dangerous ones", async () => {
  const bash = bashTool(process.cwd());
  expect(await bash.execute({ command: "echo hi" }, ctx)).toBe("hi");
  expect(await bash.execute({ command: "sudo rm -rf x" }, ctx)).toMatch(
    /Dangerous/,
  );
});

test("defaultTools exposes the five built-ins by name", () => {
  const names = defaultTools(process.cwd())
    .map((t) => t.name)
    .sort();
  expect(names).toEqual(["bash", "delete_file", "edit_file", "read_file", "write_file"]);
});

test("bash wraps the command via ctx.sandbox before executing", async () => {
  const sandboxCtx = {
    sessionId: "s",
    signal: new AbortController().signal,
    emit: () => {},
    sandbox: { id: "fake", wrap: (c: string) => `echo [${c}]` },
  };
  const out = await bashTool(process.cwd()).execute(
    { command: "hi" },
    sandboxCtx,
  );
  expect(out).toBe("[hi]");
});

test("bash runs the command unchanged under noopSandbox", async () => {
  const noopCtx = {
    sessionId: "s",
    signal: new AbortController().signal,
    emit: () => {},
    sandbox: noopSandbox(),
  };
  expect(
    await bashTool(process.cwd()).execute({ command: "echo plain" }, noopCtx),
  ).toBe("plain");
});

test("bash enforces wall-time, output, and environment limits", async () => {
  const limited = bashTool(process.cwd(), {
    timeoutMs: 20,
    maxOutputBytes: 5,
    env: { PATH: process.env.PATH },
  });
  expect(await limited.execute({ command: "printf 123456" }, ctx)).toMatch(/output exceeded/);
  expect(await limited.execute({ command: "sleep 1" }, ctx)).toMatch(/timed out/);
  expect(await limited.execute({ command: "printf %s \"$SECRET_NOT_ALLOWED\"" }, ctx)).toBe("(no output)");
});

test("bash terminates a process tree that exceeds its memory budget", async () => {
  if (process.platform === "win32") return;
  const limited = bashTool(process.cwd(), {
    timeoutMs: 5000,
    maxOutputBytes: 1000,
    memoryBytes: 1024 * 1024,
  });
  const out = await limited.execute({ command: "node -e \"setInterval(() => {}, 1000)\"" }, ctx);
  expect(out).toMatch(/memory (exceeded|monitoring unavailable)/);
});
