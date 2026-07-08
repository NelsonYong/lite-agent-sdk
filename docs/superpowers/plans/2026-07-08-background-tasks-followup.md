# Background Tasks Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 0.9.0 background feature's two defects — the `join` hang on never-exiting processes and the wasteful background-default for subagents — by splitting background tasks into `joinable` vs `detached` kinds, streaming detached (daemon) output through a new `BashOutput` tool, and flipping `Agent` back to blocking-by-default.

**Architecture:** The core `BackgroundTasks` primitive gains a task `kind`: `joinable` (finite; pushed + joined, the run waits for it) and `detached` (long-lived; never gates run termination, output pollable via a per-id read cursor, killed on run-end). The kernel's dry-out join gates on `pendingJoinable()` only, so daemons can't hang the run. `bash run_in_background:true` becomes a detached streaming child process; a new `BashOutput` tool reads its incremental output. `Agent` defaults to `run_in_background:false` (blocking) and spawns a `joinable` task when explicitly backgrounded.

**Tech Stack:** TypeScript (ESM, strict, `verbatimModuleSyntax` — value/type imports separate), vitest, zod, `node:child_process`. pnpm monorepo; packages import each other via built `dist/`, so **rebuild `@lite-agent/core` before running any `@lite-agent/sdk` test**.

**Spec:** `docs/superpowers/specs/2026-07-08-background-tasks-followup-design.md`

**Non-obvious constraints:**
- Core in-package tests import from `../src/...` (source) — no build needed for Tasks 1–2. SDK tests import `@lite-agent/core` (dist) — Tasks 3–5 must run `pnpm --filter @lite-agent/core build` first.
- `verbatimModuleSyntax`: `import type { ... }` for types, separate from value imports.
- pnpm filters: core = `@lite-agent/core`, sdk = `@lite-agent/sdk`.
- Commit identity is the repo's local git config (NelsonYong). End commit messages with the repo's Co-Authored-By trailer if your workflow adds one; otherwise a plain message is fine.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/core/src/background.ts` | The primitive: joinable/detached kinds, counts, `waitNextJoinable`, detached output buffer + `read`, `listDetached` | 1 |
| `packages/core/test/background.test.ts` | Primitive unit tests (renames + kind/read tests) | 1 |
| `packages/core/src/kernel.ts` | Dry-out join gates on `pendingJoinable()` | 2 |
| `packages/core/src/index.ts` | Export `BackgroundKind`, `BackgroundRead` | 2 |
| `packages/core/test/kernel-background.test.ts` | Kernel join tests (rename + detached-doesn't-block + cancel-on-run-end) | 2 |
| `packages/sdk/src/tools/bash.ts` | Background path → detached streaming `spawn` | 3 |
| `packages/sdk/test/bash-background.test.ts` | bash detached tests | 3 |
| `packages/sdk/src/tools/bashOutput.ts` | **New** `BashOutput` tool | 4 |
| `packages/sdk/src/tools/index.ts`, `packages/sdk/src/index.ts` | Export `bashOutputTool` | 4 |
| `packages/sdk/src/createLiteAgent.ts` | Register `BashOutput` next to `KillBackground` | 4 |
| `packages/sdk/test/bash-output.test.ts` | **New** `BashOutput` tests | 4 |
| `packages/sdk/src/tools/agent.ts` | Default `run_in_background:false`; joinable when backgrounded; description | 5 |
| `packages/sdk/test/agent-background.test.ts` | Agent blocking-default tests | 5 |

---

## Task 1: Core primitive — joinable/detached kinds + detached output buffer

**Files:**
- Modify: `packages/core/src/background.ts` (full rewrite — see Step 3)
- Test: `packages/core/test/background.test.ts`

- [ ] **Step 1: Update the existing tests for the renamed queries**

The primitive renames `pending()`→`pendingJoinable()` and `waitNext()`→`waitNextJoinable()`. All existing spawns use the default kind (now `joinable`), so their semantics are unchanged. In `packages/core/test/background.test.ts`, replace every `bg.pending()` with `bg.pendingJoinable()` and every `bg.waitNext(` with `bg.waitNextJoinable(`. The affected lines are 18, 26, 27, 37, 52, 53, 63, 65, 66, 67, 75, 82.

- [ ] **Step 2: Add failing tests for kinds, detached counting, and read**

Append to `packages/core/test/background.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @lite-agent/core test -- background`
Expected: FAIL — `pendingJoinable`/`pendingDetached`/`waitNextJoinable`/`read`/`listDetached` don't exist; `kind` is not accepted.

- [ ] **Step 4: Rewrite `packages/core/src/background.ts`**

Replace the entire file with:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @lite-agent/core test -- background`
Expected: PASS (all original + 5 new tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/background.ts packages/core/test/background.test.ts
git commit -m "feat(core): add joinable/detached kinds + detached output buffer to BackgroundTasks"
```

---

## Task 2: Kernel dry-out join gates on `pendingJoinable`; export new types

**Files:**
- Modify: `packages/core/src/kernel.ts:176-178`
- Modify: `packages/core/src/index.ts:29`
- Test: `packages/core/test/kernel-background.test.ts`

- [ ] **Step 1: Update the one existing usage that references `pending()`**

In `packages/core/test/kernel-background.test.ts:139`, change `ctx.background.pending() === 0` to `ctx.background.pendingJoinable() === 0` (that test's task is the default `joinable` kind, so the check is unchanged in meaning).

- [ ] **Step 2: Add failing tests for detached non-blocking + cleanup**

Add a detached-spawning tool near the top of `packages/core/test/kernel-background.test.ts` (after `bgErrTool`, ~line 47):

```ts
// A tool that spawns a DETACHED task that never resolves unless aborted (a daemon).
let daemonAborted = false;
const daemonTool = defineTool({
  name: "daemon",
  description: "spawn a long-lived detached task",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    if (!ctx.background) return "no background";
    const h = ctx.background.spawn({
      label: "server",
      kind: "detached",
      run: (signal) => new Promise<string>((r) => signal.addEventListener("abort", () => { daemonAborted = true; r("stopped"); })),
    });
    return `[background:${h.id}] started.`;
  },
});
```

Then append these tests:

```ts
test("a detached daemon does NOT block dry-out: the run stops and the daemon is cancelled at run-end", async () => {
  daemonAborted = false;
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "daemon", input: {} }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { result } = await drain(
    runKernel(baseCfg({ provider, tools: [daemonTool] }), "go", new AbortController().signal, "s1"),
  );
  expect(result.stopReason).toBe("stop"); // NOT hung on the never-exiting daemon
  expect(daemonAborted).toBe(true); // cancelAll at run-end stopped it
});

test("a joinable task still blocks dry-out even when a detached daemon is also running", async () => {
  daemonAborted = false;
  // turn 1: start the daemon. turn 2: start a finite joinable bg. turn 3: dry-out → join on the joinable.
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "daemon", input: {} }] } },
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c2", name: "bg", input: {} }] } },
    { text: "waiting", message: { role: "assistant", content: [textBlock("waiting")] } },
    { text: "consumed", message: { role: "assistant", content: [textBlock("consumed")] } },
  ]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, tools: [daemonTool, bgTool(10)] }), "go", new AbortController().signal, "s1"),
  );
  expect(events.some((e) => e.type === "background_completed")).toBe(true); // joinable was joined + injected
  expect(result.stopReason).toBe("stop");
  expect(daemonAborted).toBe(true); // daemon cancelled at run-end
});

test("a detached task that exits WHILE the run is active still injects a completion note", async () => {
  // The detached task resolves on the microtask queue (no external timer), so it is
  // finished by the turn-2 top drain — where takeCompleted() injects every completion,
  // joinable or detached. Push semantics for daemon exits, without gating the run.
  const detachedFinite = defineTool({
    name: "dfin",
    description: "spawn a detached task that finishes on its own",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      const h = ctx.background!.spawn({ label: "srv", kind: "detached", run: async () => "SRV DONE" });
      return `[background:${h.id}] started.`;
    },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "dfin", input: {} }] } },
    { text: "idle", message: { role: "assistant", content: [textBlock("idle")] } },
  ]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, tools: [detachedFinite] }), "go", new AbortController().signal, "s1"),
  );
  const completed = events.find((e) => e.type === "background_completed");
  expect(completed).toBeDefined();
  expect((completed as Extract<AgentEvent, { type: "background_completed" }>).completion.content).toBe("SRV DONE");
  expect(result.stopReason).toBe("stop");
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @lite-agent/core test -- kernel-background`
Expected: FAIL — the first new test hangs/times out or `daemonAborted` is false, because the current join branch blocks on `pending()` (which counts the detached daemon).

- [ ] **Step 4: Update the kernel join branch**

In `packages/core/src/kernel.ts`, replace lines 176-178:

```ts
      if (bg && (bg.pending() > 0 || bg.hasCompleted())) {
        yield { type: "turn_end", turn, stopReason: "stop" };
        if (!bg.hasCompleted()) await bg.waitNext(signal); // block until next completion or abort
```

with:

```ts
      if (bg && (bg.pendingJoinable() > 0 || bg.hasCompleted())) {
        yield { type: "turn_end", turn, stopReason: "stop" };
        if (!bg.hasCompleted()) await bg.waitNextJoinable(signal); // block until next joinable completion or abort
```

(The `bg?.cancelAll()` on abort at line 87 and on run-end at line 243 are unchanged — the run-end one is now what stops leftover detached daemons.)

- [ ] **Step 5: Export the new types**

In `packages/core/src/index.ts:29`, change:

```ts
export type { BackgroundTasks, BackgroundHandle, BackgroundCompletion, BackgroundSpawnOptions } from "./background";
```

to:

```ts
export type { BackgroundTasks, BackgroundHandle, BackgroundCompletion, BackgroundSpawnOptions, BackgroundKind, BackgroundRead } from "./background";
```

- [ ] **Step 6: Run to verify pass + typecheck**

Run: `pnpm --filter @lite-agent/core test -- kernel-background && pnpm --filter @lite-agent/core typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/kernel.ts packages/core/src/index.ts packages/core/test/kernel-background.test.ts
git commit -m "fix(core): dry-out join gates on pendingJoinable so detached daemons never hang the run"
```

---

## Task 3: SDK bash background → detached streaming process

**Files:**
- Modify: `packages/sdk/src/tools/bash.ts`
- Test: `packages/sdk/test/bash-background.test.ts`

- [ ] **Step 1: Rebuild core so the SDK sees the new API**

Run: `pnpm --filter @lite-agent/core build`
Expected: builds `dist/` with `kind`, `read`, `pendingDetached`, etc.

- [ ] **Step 2: Update the bash background tests for detached semantics**

Replace the two background tests in `packages/sdk/test/bash-background.test.ts` (the file's `import` of `pending`/`waitNext` helpers changes). Replace lines 20-38 (`"background bash returns a placeholder..."` and `"...falls back to synchronous..."`) with:

```ts
test("background bash returns a placeholder and streams output as a detached task", async () => {
  const t = bashTool(process.cwd());
  const { ctx, bg } = ctxWithBackground();
  const out = await t.execute({ command: "echo delayed", run_in_background: true }, ctx);
  expect(out).toMatch(/^\[background:bg_/);
  expect(bg.pendingDetached()).toBe(1);
  const id = out.match(/bg_[a-z0-9]+_[a-f0-9]+/)![0];
  // Accumulate incremental reads until the streamed process exits.
  let output = "";
  let done = false;
  for (let i = 0; i < 200 && !done; i++) {
    const r = bg.read(id)!;
    output += r.output;
    done = r.done;
    if (!done) await new Promise((r) => setTimeout(r, 5));
  }
  expect(done).toBe(true);
  expect(output).toContain("delayed");
});

test("background bash falls back to synchronous when no registry is present", async () => {
  const t = bashTool(process.cwd());
  const out = await t.execute({ command: "echo sync", run_in_background: true }, {
    sessionId: "s", signal: new AbortController().signal, emit: () => {},
  } as ToolContext);
  expect(out).toBe("sync"); // no ctx.background → ran inline
});

test("cancelling a running background command stops the child process", async () => {
  const t = bashTool(process.cwd());
  const { ctx, bg } = ctxWithBackground();
  const out = await t.execute({ command: "sleep 30", run_in_background: true }, ctx);
  const id = out.match(/bg_[a-z0-9]+_[a-f0-9]+/)![0];
  expect(bg.pendingDetached()).toBe(1);
  expect(bg.cancel(id)).toBe(true); // KillBackground does the same: ctx.background.cancel(id)
  // The spawned child is killed via its AbortSignal; poll until the task settles.
  for (let i = 0; i < 200 && bg.pendingDetached() > 0; i++) await new Promise((r) => setTimeout(r, 5));
  expect(bg.pendingDetached()).toBe(0);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @lite-agent/core build && pnpm --filter @lite-agent/sdk test -- bash-background`
Expected: FAIL — `pendingDetached` is undefined on the placeholder path (bash still spawns a joinable task), or output isn't readable via `read`.

- [ ] **Step 4: Rewrite the background path in `packages/sdk/src/tools/bash.ts`**

Replace the whole file with:

```ts
import { execSync, spawn as spawnChild } from "node:child_process";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool, ToolContext } from "@lite-agent/core";

const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
// Foreground commands get a hard timeout so the agent can't hang waiting on them.
// Background (detached) commands are bounded by their AbortSignal instead
// (KillBackground / run-end cancelAll); a timeout would kill the servers/watchers this is for.
const SYNC_OPTS = { encoding: "utf8" as const, maxBuffer: 50_000_000, timeout: 120000 };

async function resolveCommand(command: string, workdir: string, ctx: ToolContext): Promise<string> {
  return ctx.sandbox ? await ctx.sandbox.wrap(command, { cwd: workdir }) : command;
}

function formatExecError(e: unknown): string {
  const err = e as { stdout?: string; stderr?: string; message?: string };
  return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(0, 50_000) || `Error: ${err.message}`;
}

function runSync(toRun: string, workdir: string): string {
  try {
    const out = execSync(toRun, { ...SYNC_OPTS, cwd: workdir });
    return out.trim() || "(no output)";
  } catch (e) {
    return formatExecError(e);
  }
}

// Streaming child for a detached (background) command: stdout+stderr are pushed to the
// task's output buffer via `write` (readable with BashOutput); resolves with a short tail
// summary on exit. Bounded only by `signal` (KillBackground / run-end).
function runStreaming(toRun: string, workdir: string, signal: AbortSignal, write: (s: string) => void): Promise<string> {
  return new Promise<string>((resolve) => {
    const child = spawnChild(toRun, { cwd: workdir, shell: true, signal });
    let tail = "";
    const onData = (buf: Buffer) => { const s = buf.toString(); write(s); tail = (tail + s).slice(-2000); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => resolve(`Error: ${(e as Error).message}`));
    child.on("close", (code) => resolve(`[exit ${code ?? "null"}] ${tail.trim().slice(-500)}`.trim()));
  });
}

export function bashTool(workdir: string): Tool {
  return defineTool({
    name: "bash",
    description:
      "Run a shell command in the workspace — builds, tests, git, package managers, and searching or listing files (grep, find, ls). IMPORTANT: to read a file's contents, use the dedicated read_file tool instead of cat/head/tail; it is the preferred way and keeps whole files out of the shell output. Set run_in_background:true for long-running commands (servers, watchers, slow test suites): the command runs detached and does NOT block; read its output with the BashOutput tool (by the returned bg_… id), and it is stopped automatically when the run ends.",
    schema: z.object({
      command: z.string(),
      run_in_background: z.boolean().optional().default(false),
    }),
    execute: async ({ command, run_in_background }, ctx) => {
      if (DANGEROUS.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
      const toRun = await resolveCommand(command, workdir, ctx);
      if (run_in_background && ctx.background) {
        const handle = ctx.background.spawn({
          label: command,
          kind: "detached",
          run: (signal, _emit, write) => runStreaming(toRun, workdir, signal, write),
        });
        return `[background:${handle.id}] started: ${command}. Read output with BashOutput(id: ${handle.id}); it does not block this run and is stopped when the run ends.`;
      }
      // No registry (background disabled) → run synchronously as a graceful fallback.
      return runSync(toRun, workdir);
    },
  });
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @lite-agent/sdk test -- bash-background`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/tools/bash.ts packages/sdk/test/bash-background.test.ts
git commit -m "feat(sdk): bash run_in_background streams as a detached process readable via BashOutput"
```

---

## Task 4: New `BashOutput` tool

**Files:**
- Create: `packages/sdk/src/tools/bashOutput.ts`
- Modify: `packages/sdk/src/tools/index.ts`, `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/createLiteAgent.ts:228`
- Test: `packages/sdk/test/bash-output.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/test/bash-output.test.ts`:

```ts
import { expect, test } from "vitest";
import { bashOutputTool } from "../src/tools/bashOutput";
import { createBackgroundTasks } from "@lite-agent/core";
import type { AgentEvent, ToolContext } from "@lite-agent/core";

function ctxWithBackground() {
  const bg = createBackgroundTasks({ emit: (_e: AgentEvent) => {}, signal: new AbortController().signal });
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: () => {}, background: bg } as ToolContext;
  return { ctx, bg };
}

test("BashOutput reads a detached task's output incrementally", async () => {
  const { ctx, bg } = ctxWithBackground();
  let write!: (s: string) => void;
  const h = bg.spawn({ label: "srv", kind: "detached", run: (_s, _e, w) => new Promise<string>(() => { write = w; }) });
  const t = bashOutputTool();
  write("line one\n");
  expect(await t.execute({ id: h.id }, ctx)).toContain("line one");
  write("line two\n");
  const out2 = await t.execute({ id: h.id }, ctx);
  expect(out2).toContain("line two");
  expect(out2).not.toContain("line one"); // incremental
});

test("BashOutput filter narrows to matching lines", async () => {
  const { ctx, bg } = ctxWithBackground();
  let write!: (s: string) => void;
  const h = bg.spawn({ label: "srv", kind: "detached", run: (_s, _e, w) => new Promise<string>(() => { write = w; }) });
  write("keep me\ndrop this\n");
  expect(await bashOutputTool().execute({ id: h.id, filter: "keep" }, ctx)).toContain("keep me");
});

test("BashOutput reports an unknown id and a disabled registry", async () => {
  const { ctx } = ctxWithBackground();
  expect(await bashOutputTool().execute({ id: "bg_nope" }, ctx)).toContain("No detached background task");
  const noBg = { sessionId: "s", signal: new AbortController().signal, emit: () => {} } as ToolContext;
  expect(await bashOutputTool().execute({ id: "bg_x" }, noBg)).toBe("Background tasks are disabled.");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @lite-agent/core build && pnpm --filter @lite-agent/sdk test -- bash-output`
Expected: FAIL — `../src/tools/bashOutput` does not exist.

- [ ] **Step 3: Create `packages/sdk/src/tools/bashOutput.ts`**

```ts
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";

export function bashOutputTool(): Tool {
  return defineTool({
    name: "BashOutput",
    description:
      "Read new output from a background (detached) command started with bash run_in_background:true, by its bg_… id. Returns only output produced since your last read of that id. Optional `filter` is a regex; only matching lines are returned. When the process has exited, the result ends with [process exited].",
    schema: z.object({ id: z.string(), filter: z.string().optional() }),
    execute: async ({ id, filter }, ctx) => {
      if (!ctx.background) return "Background tasks are disabled.";
      const r = ctx.background.read(id, { filter: filter ? new RegExp(filter) : undefined });
      if (!r) return `No detached background task with id '${id}'.`;
      return (r.output || "(no new output)") + (r.done ? "\n[process exited]" : "");
    },
  });
}
```

- [ ] **Step 4: Register the tool and export it**

In `packages/sdk/src/tools/index.ts`, after line 14 (`export { killBackgroundTool } from "./killBackground";`) add:

```ts
export { bashOutputTool } from "./bashOutput";
```

In `packages/sdk/src/createLiteAgent.ts`, add the import after line 53 (`import { killBackgroundTool } from "./tools/killBackground";`):

```ts
import { bashOutputTool } from "./tools/bashOutput";
```

and change line 228:

```ts
  if (cfg.background !== false) tools.push(killBackgroundTool());
```

to:

```ts
  if (cfg.background !== false) tools.push(killBackgroundTool(), bashOutputTool());
```

In `packages/sdk/src/index.ts`, the `killBackgroundTool` re-export is line 18 inside the `export { ... } from "./tools";` block. Add `bashOutputTool,` on the next line:

```ts
  killBackgroundTool,
  bashOutputTool,
} from "./tools";
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @lite-agent/core build && pnpm --filter @lite-agent/sdk test -- bash-output && pnpm --filter @lite-agent/sdk typecheck`
Expected: PASS, no type errors. Also run the existing `defaults` test to confirm registration didn't break it: `pnpm --filter @lite-agent/sdk test -- defaults` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/tools/bashOutput.ts packages/sdk/src/tools/index.ts packages/sdk/src/index.ts packages/sdk/src/createLiteAgent.ts packages/sdk/test/bash-output.test.ts
git commit -m "feat(sdk): add BashOutput tool to read detached background command output"
```

---

## Task 5: `Agent` defaults to blocking; joinable when backgrounded

**Files:**
- Modify: `packages/sdk/src/tools/agent.ts:38-47, 100-106`
- Test: `packages/sdk/test/agent-background.test.ts`

- [ ] **Step 1: Rewrite the agent-background tests for a blocking default**

Replace the three tests in `packages/sdk/test/agent-background.test.ts` (lines 20-60) with:

```ts
test("Agent defaults to blocking: returns the aggregate directly, no placeholder", async () => {
  const t = agentTool({ loader: loader(), spawn: echoSpawn });
  const { ctx } = ctxWithBackground();
  const out = await t.execute(
    { tasks: [{ subagent_type: "general-purpose", prompt: "A" }, { subagent_type: "general-purpose", prompt: "B" }] },
    ctx,
  );
  expect(out).not.toMatch(/^\[background:/);
  expect(out).toContain("RESULT(A)");
  expect(out).toContain("RESULT(B)");
});

test("Agent with run_in_background:true backgrounds as one joinable task", async () => {
  const t = agentTool({ loader: loader(), spawn: echoSpawn });
  const { ctx, bg } = ctxWithBackground();
  const out = await t.execute(
    { tasks: [{ subagent_type: "general-purpose", prompt: "A" }, { subagent_type: "general-purpose", prompt: "B" }], run_in_background: true },
    ctx,
  );
  expect(out).toMatch(/^\[background:bg_/);
  expect(out).toContain("2 subagent");
  expect(bg.pendingJoinable()).toBe(1); // one batch = one joinable task
  await bg.waitNextJoinable(new AbortController().signal);
  const [c] = bg.takeCompleted();
  expect(c!.content).toContain("RESULT(A)");
  expect(c!.content).toContain("RESULT(B)");
});

test("backgrounded subagent events route to the run-level emit, not ctx.emit", async () => {
  const runLevel: AgentEvent[] = [];
  const ctxEmit: AgentEvent[] = [];
  const bg = createBackgroundTasks({ emit: (e) => runLevel.push(e), signal: new AbortController().signal });
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: (e: AgentEvent) => ctxEmit.push(e), background: bg } as ToolContext;
  const t = agentTool({ loader: loader(), spawn: echoSpawn });
  await t.execute({ tasks: [{ subagent_type: "general-purpose", prompt: "Q" }], run_in_background: true }, ctx);
  await bg.waitNextJoinable(new AbortController().signal);
  expect(runLevel.some((e) => e.type === "tool_use")).toBe(true);
  expect(runLevel.some((e) => e.type === "tool_result")).toBe(true);
  expect(ctxEmit.length).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @lite-agent/core build && pnpm --filter @lite-agent/sdk test -- agent-background`
Expected: FAIL — with the current `default(true)` + `!== false` guard, the default call still backgrounds (returns a placeholder), so the first test fails.

- [ ] **Step 3: Flip the schema default and dispatch guard**

In `packages/sdk/src/tools/agent.ts`, change the schema (line 46) from:

```ts
      run_in_background: z.boolean().optional().default(true),
```

to:

```ts
      run_in_background: z.boolean().optional().default(false),
```

Change the dispatch guard (lines 100-105) from:

```ts
      // !== false: a direct execute() call (bypassing schema parse) leaves this
      // undefined, which should still default to background.
      if (run_in_background !== false && ctx.background) {
        const handle = ctx.background.spawn({
          label: `${tasks.length} subagent(s)`,
          run: (signal, emit) => runBatch(signal, emit),
        });
        return `[background:${handle.id}] dispatched ${tasks.length} subagent(s). Aggregated results will be delivered when all complete.`;
      }
```

to:

```ts
      // === true: blocking is the default, so a direct execute() call (bypassing schema
      // parse) that leaves this undefined must fall through to the blocking path.
      if (run_in_background === true && ctx.background) {
        const handle = ctx.background.spawn({
          label: `${tasks.length} subagent(s)`,
          kind: "joinable",
          run: (signal, emit) => runBatch(signal, emit),
        });
        return `[background:${handle.id}] dispatched ${tasks.length} subagent(s). Aggregated results will be delivered when all complete.`;
      }
```

- [ ] **Step 4: Rewrite the tool description (blocking default)**

In `packages/sdk/src/tools/agent.ts`, replace the `description` (lines 38-43) with:

```ts
    description:
      "Delegate a large or context-heavy subtask to a specialized subagent, keeping your own context clean. Each subagent runs in isolation (it sees only the `prompt` you pass) and returns only its final result. " +
      "By default this call BLOCKS until every subagent has finished and returns all their results directly (labeled `subagent[0]`, `subagent[1]`, …) — use this whenever you need the results to continue. " +
      "Pass `run_in_background: true` only for fire-and-forget fan-out you don't need immediately: it returns a placeholder now and the aggregated results are delivered later as a notification when all subagents finish (do NOT call `Agent` again to poll them). " +
      "To run subtasks in parallel, pass them as MULTIPLE entries in `tasks` within a SINGLE call — do not issue separate `Agent` calls for that. " +
      "To continue a previous subagent, pass its reported agentId as `resume`.",
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @lite-agent/sdk test -- agent-background`
Expected: PASS.

- [ ] **Step 6: Confirm the subagent integration tests still pass**

`packages/sdk/test/subagents.test.ts` already passes `run_in_background: false` explicitly (lines 33, 46), so the default flip is a no-op for them.

Run: `pnpm --filter @lite-agent/sdk test -- subagents`
Expected: PASS (unchanged).

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/tools/agent.ts packages/sdk/test/agent-background.test.ts
git commit -m "fix(sdk): Agent subagent tool defaults to blocking; joinable when backgrounded"
```

---

## Final verification (after all tasks)

- [ ] **Full build + test + typecheck across the workspace**

Run: `pnpm -r build && pnpm -r test && pnpm -r typecheck`
Expected: all packages build in topological order, all tests pass, no type errors.

- [ ] **Grep for leftover old API names**

Run: `grep -rn "\.pending(\|\.waitNext(" packages/*/src packages/*/test`
Expected: no matches (all renamed to `pendingJoinable`/`waitNextJoinable`).

---

## Notes for the versioning step (do NOT do this during implementation)

Both `@lite-agent/core` and `lite-agent`/`@lite-agent/sdk` change. Per the repo's 0.x convention → **minor** bump. The changelog must flag two behavioral changes: (1) `Agent` now blocks by default (`run_in_background:true` restores backgrounding); (2) `bash run_in_background:true` no longer auto-delivers output — read it with `BashOutput`. Run `/version-and-changelog` separately after merge.
