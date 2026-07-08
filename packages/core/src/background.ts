import { randomBytes } from "node:crypto";
import type { AgentEvent } from "./events";

export type BackgroundKind = "joinable" | "detached";

export interface BackgroundHandle {
  id: string;
  label: string;
}

export interface BackgroundSpawnOptions {
  /** Display label — e.g. the command line, or "3 subagents". */
  label: string;
  /** "joinable" (default): finite work; the run blocks at dry-out until it settles (join).
   *  "detached": long-lived/daemon; never gates run termination, output readable via read(). */
  kind?: BackgroundKind;
  /** The work. Resolves to the final content string; a throw becomes an isError completion.
   *  - signal: task-scoped abort (KillBackground / run-abort)
   *  - emit:   run-level event sink (survives the per-turn channel)
   *  - write:  append a chunk to this task's live output buffer (detached tasks; joinable ignore it) */
  run: (signal: AbortSignal, emit: (e: AgentEvent) => void, write: (chunk: string) => void) => Promise<string>;
}

export interface BackgroundCompletion {
  id: string;
  label: string;
  content: string;
  isError: boolean;
}

export interface BackgroundRead {
  /** New output since the previous read of this id, after optional `filter`. */
  output: string;
  /** True once the task has finished (exit or error). */
  done: boolean;
}

export interface BackgroundTasks {
  /** Register and start a task; returns immediately with its handle. */
  spawn(opts: BackgroundSpawnOptions): BackgroundHandle;
  /** Count of JOINABLE tasks still running — the only kind that gates run termination. */
  pendingJoinable(): number;
  /** Count of detached tasks still running. */
  pendingDetached(): number;
  /** True if there are finished-but-not-yet-delivered completions. */
  hasCompleted(): boolean;
  /** Take and clear the delivered completions (kernel drains at a turn boundary). */
  takeCompleted(): BackgroundCompletion[];
  /** Resolve when the next task completes, on abort, or if no joinable task is running. */
  waitNextJoinable(signal: AbortSignal): Promise<void>;
  /** Read a detached task's NEW output since the last read (cursor tracked per id).
   *  null if the id is unknown or not detached. */
  read(id: string, opts?: { filter?: RegExp }): BackgroundRead | null;
  /** List live (still-running) detached tasks. */
  listDetached(): BackgroundHandle[];
  /** Cancel one running task by id (aborts its linked controller). Returns false if unknown. */
  cancel(id: string): boolean;
  /** Cancel all running tasks (called on run abort and run-end). */
  cancelAll(): void;
}

export interface BackgroundDeps {
  /** Route a background task's events to the kernel's run-level event queue. */
  emit: (e: AgentEvent) => void;
  /** The run's abort signal; cancels all tasks when it fires. */
  signal: AbortSignal;
}

/** Per detached task: 1 MB ring (drop-oldest) + an absolute read cursor. */
const BUFFER_CAP = 1_000_000;

interface Detached {
  label: string;
  buffer: string; // last <= BUFFER_CAP chars written
  written: number; // absolute total chars ever written
  read: number; // absolute position already returned by read()
  done: boolean;
}

interface Running {
  ac: AbortController;
  kind: BackgroundKind;
}

export function createBackgroundTasks(deps: BackgroundDeps): BackgroundTasks {
  const running = new Map<string, Running>();
  const detached = new Map<string, Detached>();
  const completed: BackgroundCompletion[] = [];
  let seq = 0;
  // Single-waiter slot: only the kernel calls waitNextJoinable, serially.
  let wake: (() => void) | null = null;
  const notify = () => { if (wake) { const w = wake; wake = null; w(); } };

  const countKind = (k: BackgroundKind) => {
    let n = 0;
    for (const r of running.values()) if (r.kind === k) n++;
    return n;
  };

  const write = (id: string, chunk: string) => {
    const d = detached.get(id);
    if (!d) return;
    d.written += chunk.length;
    d.buffer += chunk;
    if (d.buffer.length > BUFFER_CAP) d.buffer = d.buffer.slice(d.buffer.length - BUFFER_CAP);
  };

  const finish = (id: string, label: string, content: string, isError: boolean) => {
    if (!running.has(id)) return; // guard against double-settle
    running.delete(id);
    const d = detached.get(id);
    if (d) d.done = true;
    completed.push({ id, label, content, isError });
    notify();
  };

  return {
    spawn({ label, kind = "joinable", run }) {
      const id = `bg_${(seq++).toString(36)}_${randomBytes(3).toString("hex")}`;
      const ac = new AbortController();
      const onRunAbort = () => ac.abort();
      deps.signal.addEventListener("abort", onRunAbort, { once: true });
      running.set(id, { ac, kind });
      if (kind === "detached") detached.set(id, { label, buffer: "", written: 0, read: 0, done: false });
      void (async () => {
        try {
          const out = await run(ac.signal, deps.emit, (chunk) => write(id, chunk));
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
    pendingJoinable: () => countKind("joinable"),
    pendingDetached: () => countKind("detached"),
    hasCompleted: () => completed.length > 0,
    takeCompleted: () => completed.splice(0, completed.length),
    async waitNextJoinable(signal) {
      if (completed.length > 0 || countKind("joinable") === 0) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (signal.aborted) { notify(); return; }
        signal.addEventListener("abort", notify, { once: true });
      });
      signal.removeEventListener("abort", notify);
    },
    read(id, opts) {
      const d = detached.get(id);
      if (!d) return null;
      const bufStart = d.written - d.buffer.length; // absolute index of buffer[0]
      const from = Math.max(d.read, bufStart);
      const dropped = d.read < bufStart; // undelivered output fell out of the ring
      let slice = d.buffer.slice(from - bufStart);
      d.read = d.written;
      if (opts?.filter) slice = slice.split("\n").filter((l) => opts.filter!.test(l)).join("\n");
      return { output: (dropped ? "[…truncated]\n" : "") + slice, done: d.done };
    },
    listDetached: () =>
      [...detached.entries()].filter(([id]) => running.has(id)).map(([id, d]) => ({ id, label: d.label })),
    cancel(id) {
      const r = running.get(id);
      if (!r) return false;
      r.ac.abort();
      return true;
    },
    cancelAll() {
      for (const r of running.values()) r.ac.abort();
    },
  };
}
