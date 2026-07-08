import { expect, test } from "vitest";
import { bashTool } from "../src/tools/bash";
import { createBackgroundTasks } from "@lite-agent/core";
import type { AgentEvent, ToolContext } from "@lite-agent/core";

function ctxWithBackground(): { ctx: ToolContext; bg: ReturnType<typeof createBackgroundTasks> } {
  const bg = createBackgroundTasks({ emit: (_e: AgentEvent) => {}, signal: new AbortController().signal });
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: () => {}, background: bg } as ToolContext;
  return { ctx, bg };
}

test("foreground bash runs synchronously and returns output", async () => {
  const t = bashTool(process.cwd());
  const out = await t.execute({ command: "echo hi", run_in_background: false }, {
    sessionId: "s", signal: new AbortController().signal, emit: () => {},
  } as ToolContext);
  expect(out).toBe("hi");
});

test("background bash returns a placeholder and delivers output via the registry", async () => {
  const t = bashTool(process.cwd());
  const { ctx, bg } = ctxWithBackground();
  const out = await t.execute({ command: "echo delayed", run_in_background: true }, ctx);
  expect(out).toMatch(/^\[background:bg_/);
  expect(bg.pending()).toBe(1);
  await bg.waitNext(new AbortController().signal);
  const [c] = bg.takeCompleted();
  expect(c!.content).toBe("delayed");
  expect(c!.isError).toBe(false);
});

test("background bash falls back to synchronous when no registry is present", async () => {
  const t = bashTool(process.cwd());
  const out = await t.execute({ command: "echo sync", run_in_background: true }, {
    sessionId: "s", signal: new AbortController().signal, emit: () => {},
  } as ToolContext);
  expect(out).toBe("sync"); // no ctx.background → ran inline
});
