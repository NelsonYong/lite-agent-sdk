import { expect, test } from "vitest";
import { bashOutputTool } from "../src/tools/bashOutput";
import { createBackgroundTasks } from "@lite-agent/core";
import type { AgentEvent, ToolContext } from "@lite-agent/core";

function ctxWithBackground() {
  const bg = createBackgroundTasks({ emit: (_e: AgentEvent) => {}, signal: new AbortController().signal });
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: () => {}, background: bg } as ToolContext;
  return { ctx, bg };
}

test("BashOutput reads a detached task's output incrementally", async () => {
  const { ctx, bg } = ctxWithBackground();
  let write!: (s: string) => void;
  const h = bg.spawn({ label: "srv", kind: "detached", run: (_s, _e, w) => new Promise<string>(() => { write = w; }) });
  const t = bashOutputTool();
  write("line one\n");
  expect(await t.execute({ id: h.id }, ctx)).toContain("line one");
  write("line two\n");
  const out2 = await t.execute({ id: h.id }, ctx);
  expect(out2).toContain("line two");
  expect(out2).not.toContain("line one"); // incremental
});

test("BashOutput filter narrows to matching lines", async () => {
  const { ctx, bg } = ctxWithBackground();
  let write!: (s: string) => void;
  const h = bg.spawn({ label: "srv", kind: "detached", run: (_s, _e, w) => new Promise<string>(() => { write = w; }) });
  write("keep me\ndrop this\n");
  const out = await bashOutputTool().execute({ id: h.id, filter: "keep" }, ctx);
  expect(out).toContain("keep me");
  expect(out).not.toContain("drop this"); // proves the filter actually excludes non-matching lines
});

test("BashOutput reports an unknown id and a disabled registry", async () => {
  const { ctx } = ctxWithBackground();
  expect(await bashOutputTool().execute({ id: "bg_nope" }, ctx)).toContain("No detached background task");
  const noBg = { sessionId: "s", signal: new AbortController().signal, emit: () => {} } as ToolContext;
  expect(await bashOutputTool().execute({ id: "bg_x" }, noBg)).toBe("Background tasks are disabled.");
});
