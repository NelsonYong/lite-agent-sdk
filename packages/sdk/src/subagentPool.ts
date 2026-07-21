import { AbortError } from "@lite-agent/core";

export interface SubagentPool {
  run<T>(job: (signal: AbortSignal) => Promise<T>, parentSignal: AbortSignal): Promise<T>;
  pending(): { queued: number; running: number };
  close(): Promise<void>;
}

type Entry<T> = {
  job: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  parentSignal: AbortSignal;
  onParentAbort: () => void;
  controller?: AbortController;
  started: boolean;
  settled: boolean;
};

export function createSubagentPool(maxParallel: number): SubagentPool {
  if (!Number.isSafeInteger(maxParallel) || maxParallel <= 0) {
    throw new RangeError("maxParallel must be a positive safe integer");
  }
  const queue: Entry<unknown>[] = [];
  const active = new Set<Promise<void>>();
  const activeControllers = new Set<AbortController>();
  let running = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const settle = <T>(entry: Entry<T>, reason: "resolve" | "reject", value: T | unknown) => {
    if (entry.settled) return;
    entry.settled = true;
    entry.parentSignal.removeEventListener("abort", entry.onParentAbort);
    if (reason === "resolve") entry.resolve(value as T);
    else entry.reject(value);
  };

  const removeQueued = (entry: Entry<unknown>) => {
    const index = queue.indexOf(entry);
    if (index !== -1) queue.splice(index, 1);
  };

  const pump = () => {
    while (!closed && running < maxParallel) {
      const entry = queue.shift();
      if (!entry) return;
      if (entry.settled) continue;

      entry.started = true;
      entry.controller = new AbortController();
      activeControllers.add(entry.controller);
      running += 1;
      const task = Promise.resolve()
        .then(() => {
          if (entry.settled || closed || entry.controller!.signal.aborted) {
            settle(entry, "reject", new AbortError());
            return;
          }
          return entry.job(entry.controller!.signal);
        })
        .then(
          (value) => settle(entry, "resolve", value),
          (error) => settle(entry, "reject", error),
        )
        .then(() => {
          running -= 1;
          active.delete(task);
          activeControllers.delete(entry.controller!);
          pump();
        });
      active.add(task);
    }
  };

  return {
    run<T>(job: (signal: AbortSignal) => Promise<T>, parentSignal: AbortSignal): Promise<T> {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const result = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // The caller still receives the rejecting promise; this marks the pool's
      // own reference handled when a caller intentionally does not await it.
      void result.catch(() => {});

      let entry!: Entry<T>;
      const onParentAbort = () => {
        if (!entry.started) removeQueued(entry as Entry<unknown>);
        else entry.controller?.abort();
        settle(entry, "reject", new AbortError());
      };
      entry = { job, resolve, reject, parentSignal, onParentAbort, started: false, settled: false };

      if (closed) settle(entry, "reject", new AbortError("subagent pool closed"));
      else if (parentSignal.aborted) settle(entry, "reject", new AbortError());
      else {
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
        queue.push(entry as Entry<unknown>);
        pump();
      }
      return result;
    },

    pending() {
      return { queued: queue.length, running };
    },

    close() {
      if (closePromise) return closePromise;
      closed = true;
      for (const entry of queue.splice(0)) settle(entry, "reject", new AbortError("subagent pool closed"));
      for (const controller of activeControllers) controller.abort();
      closePromise = Promise.all([...active]).then(() => undefined);
      return closePromise;
    },
  };
}
