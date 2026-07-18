import { expect, test } from "vitest";
import { backgroundCompletionMessage, createBackgroundTasks } from "../src/background";
import type { AgentEvent } from "../src/events";

const noSignal = () => new AbortController().signal;
const mk = () => {
  const events: AgentEvent[] = [];
  const bg = createBackgroundTasks({ emit: (e) => events.push(e), signal: noSignal() });
  return { bg, events };
};

test("spawn returns a handle immediately and reports pending", () => {
  const { bg } = mk();
  let release!: () => void;
  const h = bg.spawn({ label: "x", run: () => new Promise<string>((r) => { release = () => r("done"); }) });
  expect(h.id).toMatch(/^bg_/);
  expect(h.label).toBe("x");
  expect(bg.pendingJoinable()).toBe(1);
  expect(bg.hasCompleted()).toBe(false);
  release(); // avoid dangling promise
});

test("a completed task moves to takeCompleted and clears pending", async () => {
  const { bg } = mk();
  bg.spawn({ label: "job", run: async () => "the output" });
  await bg.waitNextJoinable(noSignal());
  expect(bg.pendingJoinable()).toBe(0);
  expect(bg.hasCompleted()).toBe(true);
  const done = bg.takeCompleted();
  expect(done).toEqual([{ id: expect.stringMatching(/^bg_/), label: "job", content: "the output", isError: false }]);
  expect(bg.hasCompleted()).toBe(false); // drained
});

test("onCompleted runs after the completion is available to takeCompleted", async () => {
  const seen: string[] = [];
  let bg!: ReturnType<typeof createBackgroundTasks>;
  bg = createBackgroundTasks({
    emit: () => {},
    signal: noSignal(),
    onCompleted: (completion) => {
      expect(bg.hasCompleted()).toBe(true);
      seen.push(completion.content);
    },
  });
  bg.spawn({ label: "job", run: async () => "done" });
  await bg.waitNextJoinable(noSignal());
  expect(seen).toEqual(["done"]);
});

test("backgroundCompletionMessage preserves the existing tagged format", () => {
  expect(backgroundCompletionMessage({
    id: "bg_1",
    label: "say \"hi\"",
    content: "failed",
    isError: true,
  })).toEqual({
    role: "user",
    content:
      '<background-task-completed id="bg_1" label="say \'hi\'" status="error">\n' +
      "failed\n</background-task-completed>",
  });
});

test("a throwing task completes as isError", async () => {
  const { bg } = mk();
  bg.spawn({ label: "boom", run: async () => { throw new Error("nope"); } });
  await bg.waitNextJoinable(noSignal());
  const [c] = bg.takeCompleted();
  expect(c!.isError).toBe(true);
  expect(c!.content).toContain("nope");
});

test("run receives a signal that aborts on cancel", async () => {
  const { bg } = mk();
  const h = bg.spawn({
    label: "cancelme",
    run: (signal) => new Promise<string>((resolve) => {
      signal.addEventListener("abort", () => resolve("cancelled"));
    }),
  });
  expect(bg.cancel(h.id)).toBe(true);
  await bg.waitNextJoinable(noSignal());
  expect(bg.pendingJoinable()).toBe(0);
  expect(bg.cancel(h.id)).toBe(false); // already gone
});

test("cancelAll aborts every running task", async () => {
  const { bg } = mk();
  const mkRun = () => (signal: AbortSignal) =>
    new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("x")));
  bg.spawn({ label: "a", run: mkRun() });
  bg.spawn({ label: "b", run: mkRun() });
  expect(bg.pendingJoinable()).toBe(2);
  bg.cancelAll();
  await bg.waitNextJoinable(noSignal());
  await bg.waitNextJoinable(noSignal());
  expect(bg.pendingJoinable()).toBe(0);
});

test("waitNext returns immediately when a signal is already aborted", async () => {
  const { bg } = mk();
  bg.spawn({ label: "slow", run: () => new Promise<string>(() => {}) }); // never resolves
  const ac = new AbortController();
  ac.abort();
  await bg.waitNextJoinable(ac.signal); // must not hang
  expect(true).toBe(true);
});

test("run's emit is forwarded to the registry emit", async () => {
  const { bg, events } = mk();
  bg.spawn({ label: "e", run: async (_signal, emit) => { emit({ type: "text_delta", text: "hi" }); return "ok"; } });
  await bg.waitNextJoinable(noSignal());
  expect(events).toContainEqual({ type: "text_delta", text: "hi" });
});

test("a detached task is counted by pendingDetached, not pendingJoinable", () => {
  const { bg } = mk();
  let release!: () => void;
  bg.spawn({ label: "srv", kind: "detached", run: () => new Promise<string>((r) => { release = () => r("x"); }) });
  expect(bg.pendingDetached()).toBe(1);
  expect(bg.pendingJoinable()).toBe(0);
  release();
});

test("waitNextJoinable returns immediately when only detached tasks are running", async () => {
  const { bg } = mk();
  bg.spawn({ label: "srv", kind: "detached", run: () => new Promise<string>(() => {}) }); // never resolves
  await bg.waitNextJoinable(noSignal()); // must not hang: no joinable pending
  expect(bg.pendingDetached()).toBe(1);
});

test("read returns a detached task's new output incrementally, then done on exit", async () => {
  const { bg } = mk();
  let write!: (s: string) => void;
  let finish!: () => void;
  const h = bg.spawn({
    label: "srv", kind: "detached",
    run: (_s, _e, w) => new Promise<string>((r) => { write = w; finish = () => r("bye"); }),
  });
  write("line one\n");
  expect(bg.read(h.id)).toEqual({ output: "line one\n", done: false });
  write("line two\n");
  expect(bg.read(h.id)).toEqual({ output: "line two\n", done: false }); // only NEW output
  finish();
  await bg.waitNextJoinable(noSignal()); // wakes on any completion; drains nothing joinable but lets the task settle
  expect(bg.read(h.id)!.done).toBe(true);
});

test("read filters to matching lines", () => {
  const { bg } = mk();
  let write!: (s: string) => void;
  const h = bg.spawn({ label: "srv", kind: "detached", run: (_s, _e, w) => new Promise<string>(() => { write = w; }) });
  write("keep me\ndrop this\nkeep also\n");
  expect(bg.read(h.id, { filter: /keep/ })!.output).toBe("keep me\nkeep also");
});

test("read returns null for an unknown or joinable id; listDetached lists live detached", () => {
  const { bg } = mk();
  bg.spawn({ label: "job", run: () => new Promise<string>(() => {}) }); // joinable
  const h = bg.spawn({ label: "srv", kind: "detached", run: () => new Promise<string>(() => {}) });
  expect(bg.read("bg_nope")).toBeNull();
  expect(bg.listDetached()).toEqual([{ id: h.id, label: "srv" }]);
});

test("limits concurrent tasks and times out work", async () => {
  const bg = createBackgroundTasks({
    emit: () => {}, signal: noSignal(), limits: { maxDetached: 1, maxTaskMs: 5 },
  });
  bg.spawn({ label: "one", kind: "detached", run: () => new Promise<string>(() => {}) });
  expect(() => bg.spawn({ label: "two", kind: "detached", run: async () => "x" })).toThrow(/limit reached/);
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(bg.takeCompleted()[0]).toMatchObject({ label: "one", isError: true, content: expect.stringContaining("timed out") });
});

test("total task limit applies across joinable and detached work", () => {
  const bg = createBackgroundTasks({
    emit: () => {}, signal: noSignal(), limits: { maxTotal: 1 },
  });
  bg.spawn({ label: "one", kind: "joinable", run: () => new Promise<string>(() => {}) });
  expect(() => bg.spawn({ label: "two", kind: "detached", run: async () => "x" })).toThrow(/task limit reached/);
  bg.cancelAll();
});
