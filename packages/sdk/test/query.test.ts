import { expect, test, vi } from "vitest";
import { z } from "zod";
import { fakeProvider, memoryCheckpointer, policy, textBlock, SteerController } from "@lite-agent/core";
import type { AgentEvent, ModelProvider, ModelRequest } from "@lite-agent/core";
import { query } from "../src/query";
import { tool } from "../src/tool";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
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

test("query forwards permissionAudit to the permission gate", async () => {
  const cp = memoryCheckpointer();
  const probe = tool("probe", "probe", z.object({}), () => "ok");
  const gen = query({
    prompt: "go",
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "probe", input: {} }] } },
      { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
    ]),
    cwd: mkdtempSync(join(tmpdir(), "q-audit-")),
    sessionId: "q-audit",
    tools: [probe],
    checkpointer: cp,
    permission: policy({ allow: ["probe"] }),
    permissionAudit: true,
  });
  let r = await gen.next();
  while (!r.done) r = await gen.next();

  const decisions = [];
  for await (const e of cp.read("q-audit")) {
    if (e.event.type === "permission_decision") decisions.push(e.event);
  }
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ decision: "allow", by: "policy", turn: 1 });
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

test("query forwards a SteerController; followUp continues the run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "q-steer-"));
  const fp = fakeProvider([
    { text: "first", message: { role: "assistant", content: [textBlock("first")] } },
    { text: "second", message: { role: "assistant", content: [textBlock("second")] } },
  ]);
  const steer = new SteerController();
  steer.followUp("keep going");
  const gen = query({ prompt: "hi", model: fp, cwd, sessions: false, steer });
  const types: string[] = [];
  let r = await gen.next();
  while (!r.done) { types.push(r.value.type); r = await gen.next(); }
  // followUp resurrects the run for a second model turn → two turn_start events.
  expect(types.filter((t) => t === "turn_start").length).toBe(2);
});

test("query closes detached work owned by its temporary LiteAgent", async () => {
  let aborted = false;
  const background = tool(
    "query_background",
    "query background",
    z.object({}),
    async (_input, ctx) => {
      ctx.background!.spawn({
        label: "query task",
        kind: "detached",
        run: (signal) => new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve("cancelled");
          });
        }),
      });
      return "started";
    },
  );
  const stream = query({
    prompt: "start",
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "q1", name: "query_background", input: {} }] } },
      { text: "idle", message: { role: "assistant", content: [textBlock("idle")] } },
    ]),
    cwd: process.cwd(),
    tools: [background],
    sessions: false,
    tasks: false,
    agents: false,
    cleanup: false,
  });
  while (!(await stream.next()).done) {}
  await vi.waitFor(() => expect(aborted).toBe(true));
});

test("query waits for Agent children, streams their completion, and returns the autonomous result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "q-agent-defs-"));
  writeFileSync(
    join(dir, "worker.md"),
    "---\nname: worker\ndescription: worker agent\n---\nworker body",
  );
  let running = 0;
  let maxRunning = 0;
  let completed = 0;
  const lastText = (request: ModelRequest) => {
    const message = request.messages.at(-1);
    return message?.role === "user" && typeof message.content === "string"
      ? message.content
      : undefined;
  };
  const model: ModelProvider = {
    id: "query-subagents",
    async *stream(request) {
      if (request.system?.startsWith('You are the "worker" subagent')) {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running--;
        completed++;
        yield {
          type: "message_done",
          message: { role: "assistant", content: [textBlock("child result")] },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      if (lastText(request) === "start") {
        yield {
          type: "message_done",
          message: {
            role: "assistant",
            content: [{
              type: "tool_call",
              id: "query-agent",
              name: "Agent",
              input: {
                tasks: [1, 2].map((index) => ({
                  display_name: `Query child ${index}`,
                  subagent_type: "worker",
                  prompt: `task ${index}`,
                })),
              },
            }],
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      const completion = lastText(request)?.includes("background-task-completed");
      const text = completion ? "final after children" : "initial idle";
      yield {
        type: "message_done",
        message: { role: "assistant", content: [textBlock(text)] },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  const events = [];
  const stream = query({
    prompt: "start",
    model,
    cwd: mkdtempSync(join(tmpdir(), "q-agent-wd-")),
    agentsDir: dir,
    maxParallelSubagents: 1,
    sessionId: "query-agent-session",
    tasks: false,
    sessions: false,
    cleanup: false,
  });
  let result = await stream.next();
  while (!result.done) {
    events.push(result.value);
    result = await stream.next();
  }

  expect(result.value.text).toBe("final after children");
  expect(completed).toBe(2);
  expect(maxRunning).toBe(1);
  expect(events.filter((event) => event.type === "background_completed")).toHaveLength(1);
  expect(events.some((event) =>
    event.type === "tool_result" && event.result.name === "Query child 1" && event.result.content === "child result",
  )).toBe(true);
});

test("query ignores child done events stamped with agentId when selecting root completion", async () => {
  let releaseChild!: () => void;
  const dispatch = tool(
    "Agent",
    "dispatch groups",
    z.object({}),
    async (_input, ctx) => {
      ctx.background!.spawn({
        label: "Subagent group: first",
        kind: "detached",
        run: async () => "first done",
      });
      ctx.background!.spawn({
        label: "unrelated child",
        kind: "detached",
        run: (signal, emit) => new Promise<string>((resolve) => {
          releaseChild = () => emit({
            type: "done",
            agentId: "child-1",
            reason: "stop",
            result: {
              messages: [],
              text: "WRONG child result",
              usage: { inputTokens: 0, outputTokens: 0 },
              stopReason: "stop",
            },
          } as AgentEvent);
          signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
        }),
      });
      return "accepted";
    },
  );
  const model: ModelProvider = {
    id: "query-agent-id-filter",
    async *stream(request) {
      const last = request.messages.at(-1);
      const text = last?.role === "user" && typeof last.content === "string" ? last.content : "";
      if (text === "start") {
        yield {
          type: "message_done",
          message: {
            role: "assistant",
            content: [{ type: "tool_call", id: "dispatch", name: "Agent", input: {} }],
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      if (text.includes("<background-task-completed")) {
        releaseChild();
        await Promise.resolve();
        yield {
          type: "message_done",
          message: { role: "assistant", content: [textBlock("ROOT result")] },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      yield {
        type: "message_done",
        message: { role: "assistant", content: [textBlock("initial result")] },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  const stream = query({
    prompt: "start",
    model,
    cwd: mkdtempSync(join(tmpdir(), "q-agent-id-filter-")),
    tools: [dispatch],
    agents: false,
    tasks: false,
    sessions: false,
    cleanup: false,
  });
  let result = await stream.next();
  while (!result.done) result = await stream.next();

  expect(result.value.text).toBe("ROOT result");
});
