import { expect, test } from "vitest";
import { killBackgroundTool } from "../src/tools/killBackground";
import { createBackgroundTasks } from "@lite-agent/core";
import type { AgentEvent, ToolContext } from "@lite-agent/core";

test("KillBackground cancels a running task by id", async () => {
  const bg = createBackgroundTasks({ emit: (_e: AgentEvent) => {}, signal: new AbortController().signal });
  const h = bg.spawn({ label: "x", run: (signal) => new Promise<string>((r) => signal.addEventListener("abort", () => r("stopped"))) });
  const t = killBackgroundTool();
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: () => {}, background: bg } as ToolContext;
  const out = await t.execute({ id: h.id }, ctx);
  expect(out).toContain(h.id);
  await bg.waitNext(new AbortController().signal);
  expect(bg.pending()).toBe(0);
});

test("KillBackground reports an unknown id", async () => {
  const bg = createBackgroundTasks({ emit: (_e: AgentEvent) => {}, signal: new AbortController().signal });
  const t = killBackgroundTool();
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: () => {}, background: bg } as ToolContext;
  const out = await t.execute({ id: "bg_nope" }, ctx);
  expect(out).toContain("No running background task");
});
