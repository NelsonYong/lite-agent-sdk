import { randomBytes } from "node:crypto";
import type { AgentEvent } from "./events";

export interface BackgroundHandle {
  id: string;
  label: string;
}

export interface BackgroundSpawnOptions {
  /** Display label — e.g. the command line, or "3 subagents". */
  label: string;
  /** The actual work. Receives a task-scoped abort signal and the run-level emit.
   *  Resolves to the final content string; a throw becomes an isError completion. */
  run: (signal: AbortSignal, emit: (e: AgentEvent) => void) => Promise<string>;
}

export interface BackgroundCompletion {
  id: string;
  label: string;
  content: string;
  isError: boolean;
}

export interface BackgroundTasks {
  /** Register and start a task; returns immediately with its handle. */
  spawn(opts: BackgroundSpawnOptions): BackgroundHandle;
  /** How many tasks are still running. */
  pending(): number;
  /** True if there are finished-but-not-yet-delivered completions. */
  hasCompleted(): boolean;
  /** Take and clear the delivered completions (kernel drains at a turn boundary). */
  takeCompleted(): BackgroundCompletion[];
  /** Resolve when at least one more task completes, or when `signal` aborts, or if nothing is running. */
  waitNext(signal: AbortSignal): Promise<void>;
  /** Cancel one running task by id (aborts its linked controller). Returns false if unknown. */
  cancel(id: string): boolean;
  /** Cancel all running tasks (called on run abort). */
  cancelAll(): void;
}

export interface BackgroundDeps {
  /** Route a background task's events to the kernel's run-level event queue. */
  emit: (e: AgentEvent) => void;
  /** The run's abort signal; cancels all tasks when it fires. */
  signal: AbortSignal;
}

export function createBackgroundTasks(deps: BackgroundDeps): BackgroundTasks {
  const running = new Map<string, AbortController>();
  const completed: BackgroundCompletion[] = [];
  let seq = 0;
  // Single-waiter slot: only the kernel calls waitNext, and it does so serially
  // (one turn boundary at a time), so one wake callback is sufficient.
  let wake: (() => void) | null = null;
  const notify = () => { if (wake) { const w = wake; wake = null; w(); } };

  const finish = (id: string, label: string, content: string, isError: boolean) => {
    if (!running.has(id)) return; // guard against double-settle
    running.delete(id);
    completed.push({ id, label, content, isError });
    notify();
  };

  return {
    spawn({ label, run }) {
      const id = `bg_${(seq++).toString(36)}_${randomBytes(3).toString("hex")}`;
      const ac = new AbortController();
      const onRunAbort = () => ac.abort();
      deps.signal.addEventListener("abort", onRunAbort, { once: true });
      running.set(id, ac);
      void (async () => {
        try {
          const out = await run(ac.signal, deps.emit);
          finish(id, label, out, false);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          finish(id, label, `Error: ${msg}`, true);
        } finally {
          deps.signal.removeEventListener("abort", onRunAbort);
        }
      })();
      return { id, label };
    },
    pending: () => running.size,
    hasCompleted: () => completed.length > 0,
    takeCompleted: () => completed.splice(0, completed.length),
    async waitNext(signal) {
      if (completed.length > 0 || running.size === 0) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (signal.aborted) { notify(); return; }
        signal.addEventListener("abort", notify, { once: true });
      });
      signal.removeEventListener("abort", notify);
    },
    cancel(id) {
      const ac = running.get(id);
      if (!ac) return false;
      ac.abort();
      return true;
    },
    cancelAll() {
      for (const ac of running.values()) ac.abort();
    },
  };
}
