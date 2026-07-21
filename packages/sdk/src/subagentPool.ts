import { AbortError } from "@lite-agent/core";

export interface SubagentPool {
  run<T>(
    job: (signal: AbortSignal) => Promise<T>,
    parentSignal: AbortSignal,
    ownerSessionId?: string,
  ): Promise<T>;
  registerGroup(ownerSessionId: string): void;
  completeGroup(ownerSessionId: string): void;
  clearGroups(ownerSessionId: string): void;
  pending(): { queued: number; running: number };
  waitForIdle(ownerSessionId?: string): Promise<void>;
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
  ownerSessionId?: string;
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
  const activeEntries = new Set<Entry<unknown>>();
  const activeGroups = new Map<string, number>();
  const idleWaiters = new Map<string | undefined, Set<() => void>>();
  let idleNotificationScheduled = false;

  const hasWork = (ownerSessionId?: string) => ownerSessionId === undefined
    ? queue.length > 0 || activeEntries.size > 0 || activeGroups.size > 0
    : queue.some((entry) => entry.ownerSessionId === ownerSessionId) ||
      [...activeEntries].some((entry) => entry.ownerSessionId === ownerSessionId) ||
      (activeGroups.get(ownerSessionId) ?? 0) > 0;

  const notifyIdle = () => {
    // A pool entry can settle just before its owning BackgroundTask publishes
    // the completion that schedules the autonomous turn. Defer notification by
    // one microtask so that causal completion/scheduling is visible to callers;
    // this remains timer-independent under fake timers.
    if (idleNotificationScheduled) return;
    idleNotificationScheduled = true;
    void Promise.resolve().then(() => {
      idleNotificationScheduled = false;
      for (const [ownerSessionId, waiters] of idleWaiters) {
        if (hasWork(ownerSessionId)) continue;
        idleWaiters.delete(ownerSessionId);
        for (const resolve of waiters) resolve();
      }
    });
  };

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
    notifyIdle();
  };

  const pump = () => {
    while (!closed && running < maxParallel) {
      const entry = queue.shift();
      if (!entry) return;
      if (entry.settled) continue;

      entry.started = true;
      entry.controller = new AbortController();
      activeControllers.add(entry.controller);
      activeEntries.add(entry);
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
          activeEntries.delete(entry);
          activeControllers.delete(entry.controller!);
          pump();
          notifyIdle();
        });
      active.add(task);
    }
  };

  return {
    registerGroup(ownerSessionId) {
      activeGroups.set(ownerSessionId, (activeGroups.get(ownerSessionId) ?? 0) + 1);
    },
    completeGroup(ownerSessionId) {
      const remaining = (activeGroups.get(ownerSessionId) ?? 0) - 1;
      if (remaining > 0) activeGroups.set(ownerSessionId, remaining);
      else activeGroups.delete(ownerSessionId);
      notifyIdle();
    },
    clearGroups(ownerSessionId) {
      activeGroups.delete(ownerSessionId);
      notifyIdle();
    },
    run<T>(
      job: (signal: AbortSignal) => Promise<T>,
      parentSignal: AbortSignal,
      ownerSessionId?: string,
    ): Promise<T> {
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
      entry = {
        job,
        resolve,
        reject,
        parentSignal,
        onParentAbort,
        started: false,
        settled: false,
        ownerSessionId,
      };

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

    waitForIdle(ownerSessionId?: string) {
      if (!hasWork(ownerSessionId)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiters = idleWaiters.get(ownerSessionId) ?? new Set<() => void>();
        waiters.add(resolve);
        idleWaiters.set(ownerSessionId, waiters);
        // Atomic second check: work may have settled between the check above
        // and waiter registration.
        if (!hasWork(ownerSessionId)) notifyIdle();
      });
    },

    close() {
      if (closePromise) return closePromise;
      closed = true;
      for (const entry of queue.splice(0)) settle(entry, "reject", new AbortError("subagent pool closed"));
      for (const controller of activeControllers) controller.abort();
      closePromise = Promise.all([...active]).then(() => undefined);
      notifyIdle();
      return closePromise;
    },
  };
}
