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

test("background bash returns a placeholder and streams output as a detached task", async () => {
  const t = bashTool(process.cwd());
  const { ctx, bg } = ctxWithBackground();
  const out = await t.execute({ command: "echo delayed", run_in_background: true }, ctx);
  expect(out).toMatch(/^\[background:bg_/);
  expect(bg.pendingDetached()).toBe(1);
  const id = out.match(/bg_[a-z0-9]+_[a-f0-9]+/)![0];
  // Accumulate incremental reads until the streamed process exits.
  let output = "";
  let done = false;
  for (let i = 0; i < 200 && !done; i++) {
    const r = bg.read(id)!;
    output += r.output;
    done = r.done;
    if (!done) await new Promise((r) => setTimeout(r, 5));
  }
  expect(done).toBe(true);
  expect(output).toContain("delayed");
});

test("background bash falls back to synchronous when no registry is present", async () => {
  const t = bashTool(process.cwd());
  const out = await t.execute({ command: "echo sync", run_in_background: true }, {
    sessionId: "s", signal: new AbortController().signal, emit: () => {},
  } as ToolContext);
  expect(out).toBe("sync"); // no ctx.background → ran inline
});

test("cancelling a running background command stops the child process", async () => {
  const t = bashTool(process.cwd());
  const { ctx, bg } = ctxWithBackground();
  const out = await t.execute({ command: "sleep 30", run_in_background: true }, ctx);
  const id = out.match(/bg_[a-z0-9]+_[a-f0-9]+/)![0];
  expect(bg.pendingDetached()).toBe(1);
  expect(bg.cancel(id)).toBe(true); // KillBackground does the same: ctx.background.cancel(id)
  // The spawned child is killed via its AbortSignal; poll until the task settles.
  for (let i = 0; i < 200 && bg.pendingDetached() > 0; i++) await new Promise((r) => setTimeout(r, 5));
  expect(bg.pendingDetached()).toBe(0);
});
