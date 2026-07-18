import { expect, test, vi } from "vitest";
import { z } from "zod";
import {
  defineTool,
  fakeProvider,
  memoryCheckpointer,
  ProviderError,
  textBlock,
} from "@lite-agent/core";
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
  await vi.waitFor(() => expect(errors).toEqual(["autonomous failure"]));

  const stored = [];
  for await (const entry of checkpointer.read("provider-error")) stored.push(entry);
  expect(stored.some((entry) =>
    entry.event.type === "user" &&
    String(entry.event.message.content).includes("READY"),
  )).toBe(true);
  await agent.close();
});
