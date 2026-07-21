import { expect, test, vi } from "vitest";
import { AbortError } from "@lite-agent/core";
import { createSubagentPool } from "../src/subagentPool";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test.each([0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects an invalid maxParallel value: %s",
  (maxParallel) => {
    expect(() => createSubagentPool(maxParallel)).toThrow(RangeError);
  },
);

test("does not invoke a dequeued callback after an immediate parent abort or close", async () => {
  const abortPool = createSubagentPool(1);
  const abortParent = new AbortController();
  const abortedJob = vi.fn(async () => "should not run");
  const abortedRun = abortPool.run(abortedJob, abortParent.signal);
  abortParent.abort();
  await expect(abortedRun).rejects.toBeInstanceOf(AbortError);
  await Promise.resolve();
  expect(abortedJob).not.toHaveBeenCalled();
  expect(abortPool.pending()).toEqual({ queued: 0, running: 0 });

  const closePool = createSubagentPool(1);
  const closedJob = vi.fn(async () => "should not run");
  const closedRun = closePool.run(closedJob, new AbortController().signal);
  await closePool.close();
  await expect(closedRun).rejects.toBeInstanceOf(AbortError);
  expect(closedJob).not.toHaveBeenCalled();
  expect(closePool.pending()).toEqual({ queued: 0, running: 0 });
});

test("keeps a synchronous job throw observable without an unhandled rejection", async () => {
  const pool = createSubagentPool(1);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    const run = pool.run(() => {
      throw new Error("sync failure");
    }, new AbortController().signal);
    await expect(run).rejects.toThrow("sync failure");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("queues the third job and starts it first when a slot is released", async () => {
  const pool = createSubagentPool(2);
  const started: string[] = [];
  const first = deferred<string>();
  const second = deferred<string>();
  const third = deferred<string>();
  const parent = new AbortController();

  const firstRun = pool.run(async () => {
    started.push("first");
    return first.promise;
  }, parent.signal);
  const secondRun = pool.run(async () => {
    started.push("second");
    return second.promise;
  }, parent.signal);
  const thirdRun = pool.run(async () => {
    started.push("third");
    return third.promise;
  }, parent.signal);

  await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
  expect(pool.pending()).toEqual({ queued: 1, running: 2 });

  first.resolve("one");
  await vi.waitFor(() => expect(started).toEqual(["first", "second", "third"]));
  expect(pool.pending()).toEqual({ queued: 0, running: 2 });

  second.resolve("two");
  third.resolve("three");
  await expect(Promise.all([firstRun, secondRun, thirdRun])).resolves.toEqual(["one", "two", "three"]);
  await pool.close();
});

test("shares one parallelism limit across separately submitted groups", async () => {
  const pool = createSubagentPool(2);
  const parent = new AbortController();
  const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
  let running = 0;
  let peak = 0;

  const submitGroup = (offset: number) => gates.slice(offset, offset + 2).map((gate) =>
    pool.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
      return "done";
    }, parent.signal),
  );
  const firstGroup = submitGroup(0);
  const secondGroup = submitGroup(2);

  await vi.waitFor(() => expect(pool.pending()).toEqual({ queued: 2, running: 2 }));
  expect(peak).toBe(2);
  gates[0]!.resolve();
  gates[1]!.resolve();
  await vi.waitFor(() => expect(pool.pending().running).toBe(2));
  expect(peak).toBe(2);
  gates[2]!.resolve();
  gates[3]!.resolve();
  await expect(Promise.all([...firstGroup, ...secondGroup])).resolves.toEqual(["done", "done", "done", "done"]);
  await pool.close();
});

test("rejects a queued job when its parent signal aborts", async () => {
  const pool = createSubagentPool(1);
  const blocker = deferred<void>();
  const firstParent = new AbortController();
  const queuedParent = new AbortController();
  const first = pool.run(() => blocker.promise, firstParent.signal);
  const queued = pool.run(async () => "never", queuedParent.signal);

  await vi.waitFor(() => expect(pool.pending()).toEqual({ queued: 1, running: 1 }));
  queuedParent.abort();
  await expect(queued).rejects.toBeInstanceOf(AbortError);
  expect(pool.pending()).toEqual({ queued: 0, running: 1 });

  blocker.resolve();
  await expect(first).resolves.toBeUndefined();
  await pool.close();
});

test("aborts the signal supplied to a running job when its parent aborts", async () => {
  const pool = createSubagentPool(1);
  const parent = new AbortController();
  let jobSignal: AbortSignal | undefined;
  const run = pool.run((signal) => new Promise<string>((_resolve, reject) => {
    jobSignal = signal;
    signal.addEventListener("abort", () => reject(new AbortError()));
  }), parent.signal);

  await vi.waitFor(() => expect(jobSignal).toBeDefined());
  parent.abort();
  await expect(run).rejects.toBeInstanceOf(AbortError);
  await vi.waitFor(() => expect(pool.pending()).toEqual({ queued: 0, running: 0 }));
  expect(jobSignal!.aborted).toBe(true);
  await pool.close();
});

test("close clears pending work and does not leave unhandled rejections", async () => {
  const pool = createSubagentPool(1);
  const parent = new AbortController();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    const active = pool.run((signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new AbortError()));
    }), parent.signal);
    const queued = pool.run(async () => "never", parent.signal);

    await vi.waitFor(() => expect(pool.pending()).toEqual({ queued: 1, running: 1 }));
    const close = pool.close();
    await close;
    expect(pool.pending()).toEqual({ queued: 0, running: 0 });
    await expect(active).rejects.toBeInstanceOf(AbortError);
    await expect(queued).rejects.toBeInstanceOf(AbortError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
