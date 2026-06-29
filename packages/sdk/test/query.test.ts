import { expect, test } from "vitest";
import { z } from "zod";
import { fakeProvider, textBlock } from "@lite-agent/core";
import { query } from "../src/query";
import { tool } from "../src/tool";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectPaths } from "../src/paths";

test("query() streams events and returns a result", async () => {
  const fp = fakeProvider([
    {
      text: "hi there",
      message: { role: "assistant", content: [textBlock("hi there")] },
    },
  ]);
  const types: string[] = [];
  const gen = query({ prompt: "hi", model: fp, cwd: process.cwd() });
  let r = await gen.next();
  while (!r.done) {
    types.push(r.value.type);
    r = await gen.next();
  }
  expect(types).toContain("done");
  expect(r.value.text).toBe("hi there");
});

test("tool() builds a working Tool", async () => {
  const t = tool(
    "double",
    "double a number",
    z.object({ n: z.number() }),
    ({ n }) => String(n * 2),
  );
  expect(t.name).toBe("double");
  const ctx = {
    sessionId: "s",
    signal: new AbortController().signal,
    emit: () => {},
  };
  expect(await t.execute({ n: 3 }, ctx)).toBe("6");
});

test("query forwards sessions:false (no transcript written)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "q-wd-"));
  const gen = query({
    prompt: "hi",
    model: fakeProvider([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]),
    cwd,
    sessionId: "qs1",
    sessions: false,
  });
  // drive the generator to completion
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  const { sessionsDir } = resolveProjectPaths({ workdir: cwd, home: process.env.LITE_AGENT_HOME! });
  expect(existsSync(join(sessionsDir, "qs1.jsonl"))).toBe(false);
});

test("query forwards an explicit maxParallelTools and the kernel honors it as a bound", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = (name: string) =>
    tool(name, name, z.object({}), async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return name;
    });
  const fp = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "ta", input: {} },
      { type: "tool_call", id: "t2", name: "tb", input: {} },
      { type: "tool_call", id: "t3", name: "tc", input: {} },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  // 3 calls, cap 2 → at most 2 in flight. 2 is distinct from both 1 and the call
  // count (3): a dropped forward would default to 10 (→ 3 in flight) and fail this.
  const gen = query({ prompt: "go", model: fp, cwd: mkdtempSync(join(tmpdir(), "mpt-")), tools: [slow("ta"), slow("tb"), slow("tc")], maxParallelTools: 2 });
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  expect(maxInFlight).toBe(2);
});

test("query threads model controls end-to-end into the provider request", async () => {
  let captured: Record<string, unknown> | undefined;
  const capturing = {
    id: "cap",
    async *stream(req: Record<string, unknown>) {
      captured = req;
      yield { type: "message_done", message: { role: "assistant", content: [textBlock("ok")] }, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const gen = query({
    prompt: "hi", model: capturing as never, cwd: mkdtempSync(join(tmpdir(), "ctl-")),
    sessions: false, temperature: 0.42, topP: 0.7, seed: 9, toolChoice: "auto",
  });
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  expect(captured?.temperature).toBe(0.42);
  expect(captured?.topP).toBe(0.7);
  expect(captured?.seed).toBe(9);
  expect(captured?.toolChoice).toBe("auto");
});

test("query forwards maxParallelTools: 1 — tool calls run sequentially", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = (name: string) =>
    tool(name, name, z.object({}), async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return name;
    });
  const fp = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "ta", input: {} },
      { type: "tool_call", id: "t2", name: "tb", input: {} },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const gen = query({ prompt: "go", model: fp, cwd: mkdtempSync(join(tmpdir(), "mpt-")), tools: [slow("ta"), slow("tb")], maxParallelTools: 1 });
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  expect(maxInFlight).toBe(1);
});
