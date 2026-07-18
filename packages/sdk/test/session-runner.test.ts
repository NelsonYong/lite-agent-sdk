import { expect, test, vi } from "vitest";
import { textBlock } from "@lite-agent/core";
import type { AgentEvent, Message, RunResult } from "@lite-agent/core";
import { createSessionRunner } from "../src/sessionRunner";

const result = (text: string): RunResult => ({
  messages: [{ role: "assistant", content: [textBlock(text)] }],
  text,
  usage: { inputTokens: 0, outputTokens: 0 },
  stopReason: "stop",
});

test("a completion wakes an idle session and publishes background events", async () => {
  const inputs: Message[][] = [];
  const runner = createSessionRunner<RunResult>({ background: true });
  runner.bind(async function* (input, opts) {
    inputs.push(typeof input === "string" ? [{ role: "user", content: input }] : input);
    yield { type: "text_delta", text: opts.sessionId };
    const done = result("ok");
    yield { type: "done", reason: "stop", result: done };
    return done;
  });
  const events: Array<{ source: string; event: AgentEvent }> = [];
  runner.subscribe((entry) => events.push(entry));

  runner.backgroundTasks("s1")!.spawn({
    label: "job",
    kind: "detached",
    run: async () => "BG DONE",
  });
  await vi.waitFor(() => expect(events.some((entry) =>
    entry.source === "background" && entry.event.type === "done",
  )).toBe(true));

  expect(String(inputs[0]![0]!.content)).toContain("<background-task-completed");
  expect(String(inputs[0]![0]!.content)).toContain("BG DONE");
  await runner.close();
});

test("user and completion jobs never run concurrently in one session", async () => {
  let releaseUser!: () => void;
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const runner = createSessionRunner<RunResult>({ background: true });
  runner.bind(async function* (input) {
    active++;
    maxActive = Math.max(maxActive, active);
    const body = typeof input === "string" ? input : String(input[0]?.content);
    order.push(body.includes("background-task-completed") ? "background" : "user");
    if (body === "hold") await new Promise<void>((resolve) => { releaseUser = resolve; });
    active--;
    return result(body);
  });

  const user = runner.run("hold", { sessionId: "s1" });
  const draining = (async () => { while (!(await user.next()).done) {} })();
  await vi.waitFor(() => expect(order).toEqual(["user"]));
  runner.backgroundTasks("s1")!.spawn({
    label: "job",
    kind: "detached",
    run: async () => "done",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(order).toEqual(["user"]);
  releaseUser();
  await draining;
  await vi.waitFor(() => expect(order).toEqual(["user", "background"]));
  expect(maxActive).toBe(1);
  await runner.close();
});

test("ready completions are batched into one background run", async () => {
  const inputs: Message[][] = [];
  const runner = createSessionRunner<RunResult>({ background: true });
  runner.bind(async function* (input) {
    inputs.push(input as Message[]);
    const done = result("ok");
    yield { type: "done", reason: "stop", result: done };
    return done;
  });
  const background = runner.backgroundTasks("s1")!;
  background.spawn({ label: "one", kind: "detached", run: async () => "ONE" });
  background.spawn({ label: "two", kind: "detached", run: async () => "TWO" });
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  expect(inputs[0]).toHaveLength(2);
  expect(inputs[0]!.map((message) => String(message.content)).join("\n")).toContain("ONE");
  expect(inputs[0]!.map((message) => String(message.content)).join("\n")).toContain("TWO");
  await runner.close();
});

test("listener failures are isolated", async () => {
  const runner = createSessionRunner<RunResult>({ background: false });
  runner.bind(async function* () {
    yield { type: "text_delta", text: "ok" };
    return result("ok");
  });
  const good = vi.fn();
  runner.subscribe(() => { throw new Error("listener failed"); });
  runner.subscribe(good);
  const stream = runner.run("hello", { sessionId: "s1" });
  while (!(await stream.next()).done) {}
  expect(good).toHaveBeenCalled();
  await runner.close();
});

test("cancelSession suppresses a late completion wake", async () => {
  const execute = vi.fn(async function* () { return result("unexpected"); });
  const runner = createSessionRunner<RunResult>({ background: true });
  runner.bind(execute);
  const background = runner.backgroundTasks("s1")!;
  background.spawn({
    label: "cancelled",
    kind: "detached",
    run: (signal) => new Promise<string>((resolve) => {
      signal.addEventListener("abort", () => resolve("cancelled"));
    }),
  });
  runner.cancelSession("s1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(execute).not.toHaveBeenCalled();
  await runner.close();
});

test("cancelSession waits for an active completion run to exit", async () => {
  let entered = false;
  let release!: () => void;
  const runner = createSessionRunner<RunResult>({ background: true });
  runner.bind(async function* () {
    entered = true;
    await new Promise<void>((resolve) => { release = resolve; });
    return result("stopped");
  });
  runner.backgroundTasks("s1")!.spawn({
    label: "complete",
    kind: "detached",
    run: async () => "done",
  });
  await vi.waitFor(() => expect(entered).toBe(true));

  const cancelling = runner.cancelSession("s1");
  expect(cancelling).toBeInstanceOf(Promise);
  let settled = false;
  void (cancelling as unknown as Promise<void>).then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await cancelling;
  expect(settled).toBe(true);
  await runner.close();
});

test("close is idempotent and rejects later runs", async () => {
  const runner = createSessionRunner<RunResult>({ background: false });
  runner.bind(async function* () { return result("ok"); });
  await runner.close();
  await runner.close();
  const stream = runner.run("late", { sessionId: "s1" });
  await expect(stream.next()).rejects.toThrow("LiteAgent is closed");
});
