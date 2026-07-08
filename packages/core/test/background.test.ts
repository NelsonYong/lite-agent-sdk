import { expect, test } from "vitest";
import { createBackgroundTasks } from "../src/background";
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
  expect(bg.pending()).toBe(1);
  expect(bg.hasCompleted()).toBe(false);
  release(); // avoid dangling promise
});

test("a completed task moves to takeCompleted and clears pending", async () => {
  const { bg } = mk();
  bg.spawn({ label: "job", run: async () => "the output" });
  await bg.waitNext(noSignal());
  expect(bg.pending()).toBe(0);
  expect(bg.hasCompleted()).toBe(true);
  const done = bg.takeCompleted();
  expect(done).toEqual([{ id: expect.stringMatching(/^bg_/), label: "job", content: "the output", isError: false }]);
  expect(bg.hasCompleted()).toBe(false); // drained
});

test("a throwing task completes as isError", async () => {
  const { bg } = mk();
  bg.spawn({ label: "boom", run: async () => { throw new Error("nope"); } });
  await bg.waitNext(noSignal());
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
  await bg.waitNext(noSignal());
  expect(bg.pending()).toBe(0);
  expect(bg.cancel(h.id)).toBe(false); // already gone
});

test("cancelAll aborts every running task", async () => {
  const { bg } = mk();
  const mkRun = () => (signal: AbortSignal) =>
    new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("x")));
  bg.spawn({ label: "a", run: mkRun() });
  bg.spawn({ label: "b", run: mkRun() });
  expect(bg.pending()).toBe(2);
  bg.cancelAll();
  await bg.waitNext(noSignal());
  await bg.waitNext(noSignal());
  expect(bg.pending()).toBe(0);
});

test("waitNext returns immediately when a signal is already aborted", async () => {
  const { bg } = mk();
  bg.spawn({ label: "slow", run: () => new Promise<string>(() => {}) }); // never resolves
  const ac = new AbortController();
  ac.abort();
  await bg.waitNext(ac.signal); // must not hang
  expect(true).toBe(true);
});

test("run's emit is forwarded to the registry emit", async () => {
  const { bg, events } = mk();
  bg.spawn({ label: "e", run: async (_signal, emit) => { emit({ type: "text_delta", text: "hi" }); return "ok"; } });
  await bg.waitNext(noSignal());
  expect(events).toContainEqual({ type: "text_delta", text: "hi" });
});
