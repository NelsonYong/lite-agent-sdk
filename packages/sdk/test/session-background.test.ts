import { expect, test, vi } from "vitest";
import { z } from "zod";
import {
  defineTool,
  fakeProvider,
  memoryCheckpointer,
  textBlock,
  ProviderError,
} from "@lite-agent/core";
import type { ModelProvider } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import type { LiteAgentEvent } from "../src/liteAgent";

test("background completion wakes the idle session without blocking later user input", async () => {
  let finish!: () => void;
  const background = defineTool({
    name: "background_probe",
    description: "start deferred work",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      const handle = ctx.background!.spawn({
        label: "probe",
        kind: "detached",
        run: () => new Promise<string>((resolve) => {
          finish = () => resolve("PROBE DONE");
        }),
      });
      return `[background:${handle.id}] started`;
    },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "p1", name: "background_probe", input: {} }] } },
    { text: "spawned", message: { role: "assistant", content: [textBlock("spawned")] } },
    { text: "user answer", message: { role: "assistant", content: [textBlock("user answer")] } },
    { text: "background answer", message: { role: "assistant", content: [textBlock("background answer")] } },
  ]);
  const checkpointer = memoryCheckpointer();
  const agent = createLiteAgent({
    model: provider,
    workdir: process.cwd(),
    tools: [background],
    checkpointer,
    tasks: false,
    cleanup: false,
  });
  const seen: LiteAgentEvent[] = [];
  agent.subscribe((entry) => seen.push(entry));

  expect((await agent.send("start", { sessionId: "main" })).text).toBe("spawned");
  expect((await agent.send("question", { sessionId: "main" })).text).toBe("user answer");
  finish();
  await vi.waitFor(() => expect(seen.some((entry) =>
    entry.sessionId === "main" && entry.source === "background" &&
    entry.event.type === "done",
  )).toBe(true));

  const stored = [];
  for await (const entry of checkpointer.read("main")) stored.push(entry);
  expect(stored.some((entry) =>
    entry.event.type === "user" &&
    String(entry.event.message.content).includes("PROBE DONE"),
  )).toBe(true);
  await agent.close();
});

test("a completion remains attributed to its originating session after resume", async () => {
  let finish!: () => void;
  const tool = defineTool({
    name: "defer",
    description: "defer",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      ctx.background!.spawn({
        label: "A work",
        kind: "detached",
        run: () => new Promise<string>((resolve) => {
          finish = () => resolve("A DONE");
        }),
      });
      return "started";
    },
  });
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "a1", name: "defer", input: {} }] } },
      { text: "A idle", message: { role: "assistant", content: [textBlock("A idle")] } },
      { text: "B answer", message: { role: "assistant", content: [textBlock("B answer")] } },
      { text: "A resumed", message: { role: "assistant", content: [textBlock("A resumed")] } },
    ]),
    workdir: process.cwd(),
    tools: [tool],
    tasks: false,
    cleanup: false,
  });
  const events: LiteAgentEvent[] = [];
  agent.subscribe((entry) => events.push(entry));
  await agent.send("start A", { sessionId: "A" });
  agent.resume("B");
  await agent.send("question B");
  finish();
  await vi.waitFor(() => expect(events.some((entry) =>
    entry.sessionId === "A" && entry.source === "background" && entry.event.type === "done",
  )).toBe(true));
  expect(events.some((entry) =>
    entry.sessionId === "B" && entry.source === "background",
  )).toBe(false);
  await agent.close();
});

test("a detached output buffer is readable from a later turn", async () => {
  let taskId = "";
  const start = defineTool({
    name: "start_stream",
    description: "start stream",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      const handle = ctx.background!.spawn({
        label: "stream",
        kind: "detached",
        run: (signal, _emit, write) => new Promise<string>((resolve) => {
          write("hello later\n");
          signal.addEventListener("abort", () => resolve("stopped"));
        }),
      });
      taskId = handle.id;
      return "streaming";
    },
  });
  const read = defineTool({
    name: "read_stream",
    description: "read stream",
    schema: z.object({}),
    execute: async (_input, ctx) => ctx.background!.read(taskId)?.output ?? "missing",
  });
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "s1", name: "start_stream", input: {} }] } },
      { text: "started", message: { role: "assistant", content: [textBlock("started")] } },
      { message: { role: "assistant", content: [{ type: "tool_call", id: "r1", name: "read_stream", input: {} }] } },
      { text: "read", message: { role: "assistant", content: [textBlock("read")] } },
    ]),
    workdir: process.cwd(),
    tools: [start, read],
    tasks: false,
    sessions: false,
    cleanup: false,
  });
  await agent.send("start");
  const contents: string[] = [];
  for await (const event of agent.run("read")) {
    if (event.type === "tool_result" && event.result.name === "read_stream") {
      contents.push(event.result.content);
    }
  }
  expect(contents).toEqual(["hello later\n"]);
  await agent.close();
});

test("deleteSession cancels work without a late autonomous turn", async () => {
  let aborted = false;
  const tool = defineTool({
    name: "until_abort",
    description: "until abort",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      ctx.background!.spawn({
        label: "deleted",
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
  });
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "d1", name: "until_abort", input: {} }] } },
      { text: "idle", message: { role: "assistant", content: [textBlock("idle")] } },
    ]),
    workdir: process.cwd(),
    tools: [tool],
    checkpointer: memoryCheckpointer(),
    tasks: false,
    cleanup: false,
  });
  const backgroundDone = vi.fn();
  agent.subscribe((entry) => {
    if (entry.source === "background" && entry.event.type === "done") backgroundDone();
  });
  await agent.send("start", { sessionId: "delete-me" });
  await agent.deleteSession("delete-me");
  await vi.waitFor(() => expect(aborted).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(backgroundDone).not.toHaveBeenCalled();
  await agent.close();
});

test("a rejected background task wakes the session with an error-tagged completion", async () => {
  const checkpointer = memoryCheckpointer();
  const reject = defineTool({
    name: "reject_background",
    description: "reject background",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      ctx.background!.spawn({
        label: "broken",
        kind: "detached",
        run: async () => { throw new Error("boom"); },
      });
      return "started";
    },
  });
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "e1", name: "reject_background", input: {} }] } },
      { text: "idle", message: { role: "assistant", content: [textBlock("idle")] } },
      { text: "handled", message: { role: "assistant", content: [textBlock("handled")] } },
    ]),
    workdir: process.cwd(),
    tools: [reject],
    checkpointer,
    tasks: false,
    cleanup: false,
  });
  const events: LiteAgentEvent[] = [];
  agent.subscribe((entry) => events.push(entry));

  await agent.send("start", { sessionId: "error-task" });
  await vi.waitFor(() => expect(events.some((entry) =>
    entry.source === "background" && entry.event.type === "done",
  )).toBe(true));

  const stored = [];
  for await (const entry of checkpointer.read("error-task")) stored.push(entry);
  expect(stored.some((entry) =>
    entry.event.type === "user" &&
    String(entry.event.message.content).includes('status="error"') &&
    String(entry.event.message.content).includes("boom"),
  )).toBe(true);
  await agent.close();
});

test("a provider failure in an autonomous turn is published after persisting the completion", async () => {
  let finish!: () => void;
  let enterFailure!: () => void;
  let releaseFailure!: () => void;
  const failureEntered = new Promise<void>((resolve) => { enterFailure = resolve; });
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  let calls = 0;
  const inner = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "f1", name: "defer_failure", input: {} }] } },
    { text: "idle", message: { role: "assistant", content: [textBlock("idle")] } },
  ]);
  const model = {
    id: "background-provider-failure",
    stream(request: Parameters<typeof inner.stream>[0], signal?: AbortSignal) {
      calls++;
      if (calls === 3) {
        return (async function* () {
          enterFailure();
          await failureGate;
          throw new ProviderError("autonomous failure");
        })();
      }
      return inner.stream(request, signal);
    },
  };
  const tool = defineTool({
    name: "defer_failure",
    description: "defer failure",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      ctx.background!.spawn({
        label: "provider failure",
        kind: "detached",
        run: () => new Promise<string>((resolve) => {
          finish = () => resolve("READY");
        }),
      });
      return "started";
    },
  });
  const checkpointer = memoryCheckpointer();
  const agent = createLiteAgent({
    model,
    workdir: process.cwd(),
    tools: [tool],
    checkpointer,
    tasks: false,
    cleanup: false,
  });
  const errors: string[] = [];
  agent.subscribe((entry) => {
    if (entry.source === "background" && entry.event.type === "error") {
      errors.push(entry.event.error.message);
    }
  });

  await agent.send("start", { sessionId: "provider-error" });
  finish();
  await failureEntered;
  const idle = agent.awaitIdle("provider-error");
  releaseFailure();
  await expect(idle).resolves.toBeUndefined();
  expect(errors).toEqual(["autonomous failure"]);

  const stored = [];
  for await (const entry of checkpointer.read("provider-error")) stored.push(entry);
  expect(stored.some((entry) =>
    entry.event.type === "user" &&
    String(entry.event.message.content).includes("READY"),
  )).toBe(true);
  await agent.close();
});

test("concurrent close resolves during an autonomous provider failure", async () => {
  let finish!: () => void;
  let enterFailure!: () => void;
  let releaseFailure!: () => void;
  const failureEntered = new Promise<void>((resolve) => { enterFailure = resolve; });
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  let calls = 0;
  const inner = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "f2", name: "defer_close_failure", input: {} }] } },
    { text: "idle", message: { role: "assistant", content: [textBlock("idle")] } },
  ]);
  const model = {
    id: "background-close-provider-failure",
    stream(request: Parameters<typeof inner.stream>[0], signal?: AbortSignal) {
      calls++;
      if (calls === 3) {
        return (async function* () {
          enterFailure();
          await failureGate;
          throw new ProviderError("autonomous close failure");
        })();
      }
      return inner.stream(request, signal);
    },
  };
  const tool = defineTool({
    name: "defer_close_failure",
    description: "defer close failure",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      ctx.background!.spawn({
        label: "provider close failure",
        kind: "detached",
        run: () => new Promise<string>((resolve) => {
          finish = () => resolve("READY");
        }),
      });
      return "started";
    },
  });
  const agent = createLiteAgent({
    model,
    workdir: process.cwd(),
    tools: [tool],
    tasks: false,
    sessions: false,
    cleanup: false,
  });

  await agent.send("start", { sessionId: "provider-close-error" });
  finish();
  await failureEntered;
  const closes = Promise.all([agent.close(), agent.close()]);
  releaseFailure();

  await expect(closes).resolves.toEqual([undefined, undefined]);
});

test("awaitIdle ignores an unrelated detached daemon and close still cancels it", async () => {
  let aborted = false;
  const daemon = defineTool({
    name: "daemon",
    description: "start a daemon",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      ctx.background!.spawn({
        label: "daemon",
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
  });
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "daemon-1", name: "daemon", input: {} }] } },
      { text: "idle", message: { role: "assistant", content: [textBlock("idle")] } },
    ]),
    workdir: process.cwd(),
    tools: [daemon],
    tasks: false,
    sessions: false,
    cleanup: false,
  });

  await agent.send("start", { sessionId: "daemon-session" });
  await expect(Promise.race([
    agent.awaitIdle("daemon-session").then(() => "idle"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 100)),
  ])).resolves.toBe("idle");
  await agent.close();
  expect(aborted).toBe(true);
});

test("awaitIdle is isolated by session owner when another session has a slow child", async () => {
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const lastText = (request: Parameters<ModelProvider["stream"]>[0]) => {
    const message = request.messages.at(-1);
    return message?.role === "user" && typeof message.content === "string"
      ? message.content
      : undefined;
  };
  const model: ModelProvider = {
    id: "session-owned-subagent-pool",
    async *stream(request) {
      if (request.system?.startsWith('You are the "general-purpose" subagent')) {
        if (lastText(request) === "slow") await slow;
        yield {
          type: "message_done",
          message: { role: "assistant", content: [textBlock("child done")] },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      const prompt = lastText(request);
      if (prompt === "start A" || prompt === "start B") {
        yield {
          type: "message_done",
          message: {
            role: "assistant",
            content: [{
              type: "tool_call",
              id: prompt === "start A" ? "dispatch-a" : "dispatch-b",
              name: "Agent",
              input: {
                tasks: [{
                  display_name: prompt === "start A" ? "Slow" : "Fast",
                  subagent_type: "general-purpose",
                  prompt: prompt === "start A" ? "slow" : "fast",
                }],
              },
            }],
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      yield {
        type: "message_done",
        message: { role: "assistant", content: [textBlock("idle")] },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  const agent = createLiteAgent({
    model,
    workdir: process.cwd(),
    maxParallelSubagents: 2,
    tasks: false,
    sessions: false,
    cleanup: false,
  });

  await Promise.all([
    agent.send("start A", { sessionId: "session-A" }),
    agent.send("start B", { sessionId: "session-B" }),
  ]);
  await expect(Promise.race([
    agent.awaitIdle("session-B").then(() => "idle"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 100)),
  ])).resolves.toBe("idle");
  releaseSlow();
  await agent.awaitIdle("session-A");
  await agent.close();
});

test("awaitIdle does not depend on a real timer", async () => {
  vi.useFakeTimers();
  let settled = false;
  try {
    const agent = createLiteAgent({
      model: fakeProvider([
        { message: { role: "assistant", content: [{ type: "tool_call", id: "timer-agent", name: "Agent", input: { tasks: [{ display_name: "Worker", subagent_type: "general-purpose", prompt: "fast" }] } }] } },
        { text: "child", message: { role: "assistant", content: [textBlock("child")] } },
        { text: "parent", message: { role: "assistant", content: [textBlock("parent")] } },
      ]),
      workdir: process.cwd(),
      tasks: false,
      sessions: false,
      cleanup: false,
    });
    await agent.send("start", { sessionId: "fake-timer" });
    const idle = agent.awaitIdle("fake-timer").then(() => { settled = true; });
    for (let i = 0; i < 1000 && !settled; i++) await Promise.resolve();
    expect(settled).toBe(true);
    await idle;
    await agent.close();
  } finally {
    if (!settled) vi.runAllTimers();
    vi.useRealTimers();
  }
});
