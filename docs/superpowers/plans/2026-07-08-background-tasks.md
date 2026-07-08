# Background Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let bash and subagent tool calls run in the background — returning a placeholder immediately and notifying the main agent when they finish — with the current `run()` staying alive until all its background work completes.

**Architecture:** A generic `BackgroundTasks` primitive in `@lite-agent/core` (sibling to `SteerController`) manages opaque running promises. The kernel constructs one per run, injects each completion as a `<background-task-completed>` user message at a turn boundary (reusing the steer injection seam), and — when the model runs dry but tasks are still pending — blocks and joins instead of stopping. The sdk `bash` tool (foreground-default) and `Agent` tool (background-default) opt calls in via a `run_in_background` flag; a `KillBackground` tool cancels a hung task. Everything is gated by a top-level `background` option (default on).

**Tech Stack:** TypeScript (strict ESM), zod tool schemas, vitest with `fakeProvider` golden-stream tests, pnpm monorepo (build-before-test between packages).

**Reference spec:** `docs/superpowers/specs/2026-07-08-background-tasks-design.md`

---

## File Structure

**Create:**
- `packages/core/src/background.ts` — the `BackgroundTasks` primitive + `createBackgroundTasks` factory + its interfaces.
- `packages/core/test/background.test.ts` — unit tests for the primitive.
- `packages/sdk/src/tools/killBackground.ts` — the `KillBackground` cancel tool.
- `packages/sdk/test/background.test.ts` — sdk-level integration tests (bash background, Agent background, KillBackground).

**Modify:**
- `packages/core/src/events.ts` — add the `background_completed` event variant.
- `packages/core/src/strategies.ts` — add `background?: BackgroundTasks` to `ToolContext`.
- `packages/core/src/kernel.ts` — construct registry, thread into tool ctx, inject completions at turn top, join at dry-out, cancel on abort.
- `packages/core/src/createAgent.ts` — add `background?: boolean` to `CreateAgentConfig`, pass to `KernelConfig`.
- `packages/core/src/index.ts` — export `createBackgroundTasks` + the `BackgroundTasks`/`BackgroundHandle`/`BackgroundCompletion` types.
- `packages/sdk/src/tools/bash.ts` — add `run_in_background` (default false); async-exec background path.
- `packages/sdk/src/tools/agent.ts` — add `run_in_background` (default true); wrap the batch in one spawn.
- `packages/sdk/src/tools/index.ts` — export `killBackgroundTool` if the barrel re-exports tools (verify).
- `packages/sdk/src/createLiteAgent.ts` — add `background?: boolean`, pass to `createAgent`, register `KillBackground`.
- `packages/sdk/src/query.ts` — add `background?: boolean` passthrough.

---

## Task 1: `BackgroundTasks` primitive (core)

**Files:**
- Create: `packages/core/src/background.ts`
- Test: `packages/core/test/background.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/background.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lite-agent/core test -- background`
Expected: FAIL — `createBackgroundTasks` is not exported / module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/background.ts`:

```ts
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
          finish(id, label, `Error: ${(e as Error).message}`, true);
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
    },
    cancel(id) {
      const ac = running.get(id);
      if (!ac) return false;
      ac.abort(); // the run promise settles → finish() with isError
      return true;
    },
    cancelAll() {
      for (const ac of running.values()) ac.abort();
    },
  };
}
```

- [ ] **Step 4: Export from the core barrel**

In `packages/core/src/index.ts`, add after the `SteerController` export (line 27):

```ts
export { createBackgroundTasks } from "./background";
export type { BackgroundTasks, BackgroundHandle, BackgroundCompletion, BackgroundSpawnOptions } from "./background";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @lite-agent/core test -- background`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/background.ts packages/core/test/background.test.ts packages/core/src/index.ts
git commit -m "feat(core): add BackgroundTasks primitive"
```

---

## Task 2: `background_completed` event + `ToolContext.background` + `KernelConfig.background` (types)

**Files:**
- Modify: `packages/core/src/events.ts:38-52`
- Modify: `packages/core/src/strategies.ts:19-30`
- Modify: `packages/core/src/kernel.ts:15-35`

This task is types-only; it is verified by `typecheck`, not a unit test. Keep it a separate commit so Task 3's logic diff stays focused.

- [ ] **Step 1: Add the event variant**

In `packages/core/src/events.ts`, add an import at the top (after line 3's type imports) and a union member. First add the import:

```ts
import type { BackgroundCompletion } from "./background";
```

Then in the `AgentEventBody` union, add after the `steer` line (line 49):

```ts
  | { type: "background_completed"; completion: BackgroundCompletion }
```

- [ ] **Step 2: Add `background` to `ToolContext`**

In `packages/core/src/strategies.ts`, add the import after line 6:

```ts
import type { BackgroundTasks } from "./background";
```

Then in `interface ToolContext` (after the `sandbox?` line, line 25):

```ts
  readonly background?: BackgroundTasks;
```

- [ ] **Step 3: Add `background` to `KernelConfig`**

In `packages/core/src/kernel.ts`, add to `interface KernelConfig` (after the `steer?` line, line 34):

```ts
  /** Enable background tasks (default true). When false, ctx.background is undefined. */
  background?: boolean;
```

- [ ] **Step 4: Verify it typechecks**

Run: `pnpm --filter @lite-agent/core typecheck`
Expected: PASS (no errors — the new field is optional and unused so far).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events.ts packages/core/src/strategies.ts packages/core/src/kernel.ts
git commit -m "feat(core): add background_completed event + ToolContext/KernelConfig fields"
```

---

## Task 3: Kernel join loop (core)

**Files:**
- Modify: `packages/core/src/kernel.ts`
- Test: `packages/core/test/kernel-background.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/kernel-background.test.ts`:

```ts
import { expect, test } from "vitest";
import { z } from "zod";
import { runKernel } from "../src/kernel";
import type { KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { fakeProvider } from "../src/testing/fakeProvider";
import { defineTool } from "../src/tools/define";
import { textBlock } from "../src/types";
import { noopSandbox } from "../src/sandbox";
import type { AgentEvent, RunResult } from "../src/events";

function baseCfg(over: Partial<KernelConfig>): KernelConfig {
  return { provider: fakeProvider([]), codec: nativeCodec(), tools: [], middleware: [], model: "fake", maxTurns: 10, sandbox: noopSandbox(), ...over };
}
async function drain(gen: AsyncGenerator<AgentEvent, RunResult>) {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return { events, result: r.value };
}

// A tool that spawns a background task resolving after `ms`, and returns a placeholder immediately.
const bgTool = (ms: number) => defineTool({
  name: "bg",
  description: "spawn background work",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    if (!ctx.background) return "no background";
    const h = ctx.background.spawn({
      label: "work",
      run: () => new Promise<string>((r) => setTimeout(() => r("BG RESULT"), ms)),
    });
    return `[background:${h.id}] started.`;
  },
});

test("run joins background work: it does not stop until the task completes and its result is injected", async () => {
  // turn 1: call bg tool. turn 2+: model produces no tool calls (dry-out).
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bg", input: {} }] } },
    { text: "all done", message: { role: "assistant", content: [textBlock("all done")] } },
  ]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, tools: [bgTool(10)] }), "go", new AbortController().signal, "s1"),
  );
  // The completion was delivered as an observational event...
  const completed = events.find((e) => e.type === "background_completed");
  expect(completed).toBeDefined();
  expect((completed as Extract<AgentEvent, { type: "background_completed" }>).completion.content).toBe("BG RESULT");
  // ...and the run only finished after joining (stopReason stop, done last).
  expect(result.stopReason).toBe("stop");
  expect(events[events.length - 1]!.type).toBe("done");
});

test("the injected notification reaches the model as a tagged user message", async () => {
  const seen: string[] = [];
  const inner = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bg", input: {} }] } },
    { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
  ]);
  const provider = {
    id: "rec",
    stream: (req: Parameters<typeof inner.stream>[0], signal?: AbortSignal) => {
      for (const m of req.messages) if (typeof m.content === "string") seen.push(m.content);
      return inner.stream(req, signal);
    },
  };
  await drain(runKernel(baseCfg({ provider, tools: [bgTool(5)] }), "go", new AbortController().signal, "s1"));
  expect(seen.some((c) => c.includes("<background-task-completed") && c.includes("BG RESULT"))).toBe(true);
});

test("a slow background task does not exhaust the maxTurns budget", async () => {
  // maxTurns 2, but the model dry-outs on turn 2 while the task is still running.
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bg", input: {} }] } },
    { text: "waiting", message: { role: "assistant", content: [textBlock("waiting")] } },
    { text: "consumed", message: { role: "assistant", content: [textBlock("consumed")] } },
  ]);
  const { result } = await drain(
    runKernel(baseCfg({ provider, tools: [bgTool(30)], maxTurns: 2 }), "go", new AbortController().signal, "s1"),
  );
  // Without the maxTurns exemption this would end "max_turns" with a dangling task.
  expect(result.stopReason).toBe("stop");
});

test("background disabled: ctx.background is undefined and the tool runs synchronously", async () => {
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bg", input: {} }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { events } = await drain(
    runKernel(baseCfg({ provider, tools: [bgTool(5)], background: false }), "go", new AbortController().signal, "s1"),
  );
  expect(events.some((e) => e.type === "background_completed")).toBe(false);
  const tr = events.find((e) => e.type === "tool_result");
  expect((tr as Extract<AgentEvent, { type: "tool_result" }>).result.content).toBe("no background");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lite-agent/core test -- kernel-background`
Expected: FAIL — no `background_completed` event is emitted; `ctx.background` is undefined so the tool returns "no background".

- [ ] **Step 3: Construct the registry and thread it into tool ctx**

In `packages/core/src/kernel.ts`, add the import near the other local imports (after line 13's `SteerController` import):

```ts
import { createBackgroundTasks } from "./background";
```

After the `emit` definition (line 62), construct the registry:

```ts
  const bg = cfg.background === false ? undefined : createBackgroundTasks({ emit, signal });
```

In `baseExec`, extend the object passed to `tool.execute` (line 176) to include `background: bg`:

```ts
          const out = await tool.execute(parsed, { sessionId, signal, emit: callEmit, sandbox: cfg.sandbox, input: cfg.input, call, recordSnapshot, background: bg });
```

- [ ] **Step 4: Add the notification helper**

First, at the TOP of `packages/core/src/kernel.ts`, directly under the value import you added in Step 3, add the type import (separate statement — `verbatimModuleSyntax` requires value and type imports to be distinct):

```ts
import type { BackgroundCompletion } from "./background";
```

Then add the helper at the BOTTOM of the file (after `lastAssistantText`, outside `runKernel`). `Message` is already imported at the top (line 3):

```ts
function backgroundNote(c: BackgroundCompletion): Message {
  const status = c.isError ? ' status="error"' : "";
  return {
    role: "user",
    content: `<background-task-completed id="${c.id}" label="${c.label}"${status}>\n${c.content}\n</background-task-completed>`,
  };
}
```

- [ ] **Step 5: Inject completed notifications at turn top**

In `packages/core/src/kernel.ts`, right after the steer-injection block (after line 91, the `if (steers.length) { ... }` block), add:

```ts
    if (bg) {
      for (const c of bg.takeCompleted()) {
        const note = backgroundNote(c);
        ctx.messages.push(note);
        await append({ type: "user", message: note });
        yield { type: "background_completed", completion: c };
      }
    }
```

- [ ] **Step 6: Join at model dry-out**

In `packages/core/src/kernel.ts`, replace the dry-out block (lines 139-151, the `if (calls.length === 0) { ... }` body) with:

```ts
    if (calls.length === 0) {
      const followUps = cfg.steer?.takeFollowUps() ?? [];
      if (followUps.length) {
        yield { type: "turn_end", turn, stopReason: "stop" };
        ctx.messages.push(...followUps);
        for (const m of followUps) await append({ type: "user", message: m });
        yield { type: "steer", messages: followUps };
        continue; // resurrect: keep looping instead of stopping
      }
      // Background join: don't stop while tasks are still running or undelivered.
      if (bg && (bg.pending() > 0 || bg.hasCompleted())) {
        yield { type: "turn_end", turn, stopReason: "stop" };
        if (!bg.hasCompleted()) await bg.waitNext(signal); // block until next completion or abort
        turn--; // exempt this wait iteration from the maxTurns budget
        continue; // back to turn top → completions inject → model consumes
      }
      yield { type: "turn_end", turn, stopReason: "stop" };
      stopReason = "stop";
      break;
    }
```

- [ ] **Step 7: Cancel background tasks on abort**

In `packages/core/src/kernel.ts`, in the abort check at the top of the turn loop (line 82), add a `cancelAll`:

```ts
    if (signal.aborted) { bg?.cancelAll(); stopReason = "aborted"; break; }
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @lite-agent/core test -- kernel-background`
Expected: PASS (4 tests).

- [ ] **Step 9: Run the full core suite (regression guard)**

Run: `pnpm --filter @lite-agent/core test`
Expected: PASS — existing kernel/steer/checkpoint golden streams are unchanged (the registry exists but no tool uses it, so `takeCompleted` is always empty and the dry-out `bg` branch is never taken).

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/kernel.ts packages/core/test/kernel-background.test.ts
git commit -m "feat(core): kernel background-task join loop + completion injection"
```

---

## Task 4: Pass `background` through `createAgent` (core)

**Files:**
- Modify: `packages/core/src/createAgent.ts:14-34,43-61`

- [ ] **Step 1: Add the config field**

In `packages/core/src/createAgent.ts`, add to `interface CreateAgentConfig` (after the `maxParallelTools?` line, line 33):

```ts
  /** Enable background tasks (default true). */
  background?: boolean;
```

- [ ] **Step 2: Forward it into `KernelConfig`**

In the `kernelCfg` object (after the `maxParallelTools` line, line 60), add:

```ts
    background: cfg.background,
```

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm --filter @lite-agent/core typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/createAgent.ts
git commit -m "feat(core): thread background option through createAgent"
```

---

## Task 5: bash `run_in_background` (sdk)

**Files:**
- Modify: `packages/sdk/src/tools/bash.ts`
- Test: `packages/sdk/test/bash-background.test.ts`

**Note:** the background path MUST use async `exec` (not `execSync`, which blocks the event loop and would freeze the model stream). Foreground keeps `execSync` unchanged.

- [ ] **Step 1: Rebuild core so the sdk sees the new `ToolContext.background` type**

Run: `pnpm --filter @lite-agent/core build`
Expected: `dist/` regenerated (the sdk imports core via its built `dist`, per the repo's build-before-test rule).

- [ ] **Step 2: Write the failing test**

Create `packages/sdk/test/bash-background.test.ts`:

```ts
import { expect, test } from "vitest";
import { bashTool } from "../src/tools/bash";
import { createBackgroundTasks } from "@lite-agent/core";
import type { AgentEvent, ToolContext } from "@lite-agent/core";

function ctxWithBackground(): { ctx: ToolContext; bg: ReturnType<typeof createBackgroundTasks> } {
  const bg = createBackgroundTasks({ emit: (_e: AgentEvent) => {}, signal: new AbortController().signal });
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: () => {}, background: bg } as ToolContext;
  return { ctx, bg };
}

test("foreground bash runs synchronously and returns output", async () => {
  const t = bashTool(process.cwd());
  const out = await t.execute({ command: "echo hi", run_in_background: false }, {
    sessionId: "s", signal: new AbortController().signal, emit: () => {},
  } as ToolContext);
  expect(out).toBe("hi");
});

test("background bash returns a placeholder and delivers output via the registry", async () => {
  const t = bashTool(process.cwd());
  const { ctx, bg } = ctxWithBackground();
  const out = await t.execute({ command: "echo delayed", run_in_background: true }, ctx);
  expect(out).toMatch(/^\[background:bg_/);
  expect(bg.pending()).toBe(1);
  await bg.waitNext(new AbortController().signal);
  const [c] = bg.takeCompleted();
  expect(c!.content).toBe("delayed");
  expect(c!.isError).toBe(false);
});

test("background bash falls back to synchronous when no registry is present", async () => {
  const t = bashTool(process.cwd());
  const out = await t.execute({ command: "echo sync", run_in_background: true }, {
    sessionId: "s", signal: new AbortController().signal, emit: () => {},
  } as ToolContext);
  expect(out).toBe("sync"); // no ctx.background → ran inline
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter lite-agent test -- bash-background`
Expected: FAIL — schema rejects `run_in_background`, and there is no background path.

- [ ] **Step 4: Rewrite `bash.ts` with foreground + background paths**

Replace the entire contents of `packages/sdk/src/tools/bash.ts`:

```ts
import { execSync, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool, ToolContext } from "@lite-agent/core";

const execAsync = promisify(execCb);
const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
const OPTS = { encoding: "utf8" as const, timeout: 120000, maxBuffer: 50_000_000 };

async function resolveCommand(command: string, workdir: string, ctx: ToolContext): Promise<string> {
  return ctx.sandbox ? await ctx.sandbox.wrap(command, { cwd: workdir }) : command;
}

function runSync(toRun: string, workdir: string): string {
  try {
    const out = execSync(toRun, { cwd: workdir, ...OPTS });
    return out.trim() || "(no output)";
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(0, 50_000) || `Error: ${err.message}`;
  }
}

async function runAsync(toRun: string, workdir: string, signal: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execAsync(toRun, { cwd: workdir, signal, ...OPTS });
    return stdout.trim() || "(no output)";
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(0, 50_000) || `Error: ${err.message}`;
  }
}

export function bashTool(workdir: string): Tool {
  return defineTool({
    name: "bash",
    description:
      "Run a shell command in the workspace — builds, tests, git, package managers, and searching or listing files (grep, find, ls). IMPORTANT: to read a file's contents, use the dedicated read_file tool instead of cat/head/tail; it is the preferred way and keeps whole files out of the shell output. Set run_in_background:true for long-running commands (servers, watchers, slow test suites); its output is delivered to you automatically when it finishes.",
    schema: z.object({
      command: z.string(),
      run_in_background: z.boolean().optional().default(false),
    }),
    execute: async ({ command, run_in_background }, ctx) => {
      if (DANGEROUS.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
      const toRun = await resolveCommand(command, workdir, ctx);
      if (run_in_background && ctx.background) {
        const h = ctx.background.spawn({
          label: command,
          run: (signal) => runAsync(toRun, workdir, signal),
        });
        return `[background:${h.id}] started: ${command}. Output will be delivered when it completes.`;
      }
      return runSync(toRun, workdir);
    },
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter lite-agent test -- bash-background`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/tools/bash.ts packages/sdk/test/bash-background.test.ts
git commit -m "feat(sdk): bash run_in_background (async exec)"
```

---

## Task 6: Agent `run_in_background` default-true (sdk)

**Files:**
- Modify: `packages/sdk/src/tools/agent.ts:33-91`
- Test: `packages/sdk/test/agent-background.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/agent-background.test.ts`:

```ts
import { expect, test } from "vitest";
import { agentTool } from "../src/tools/agent";
import type { Spawn } from "../src/tools/agent";
import { AgentLoader } from "../src/agents/loader";
import { builtinAgents } from "../src/agents/builtin";
import { createBackgroundTasks } from "@lite-agent/core";
import type { AgentEvent, ToolContext } from "@lite-agent/core";

const loader = () => new AgentLoader([], builtinAgents());
// A spawn stub that echoes the prompt back as the subagent's result.
const echoSpawn: Spawn = async (_def, prompt) => `RESULT(${prompt})`;

function ctxWithBackground() {
  const bg = createBackgroundTasks({ emit: (_e: AgentEvent) => {}, signal: new AbortController().signal });
  const emitted: AgentEvent[] = [];
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: (e: AgentEvent) => emitted.push(e), background: bg } as ToolContext;
  return { ctx, bg, emitted };
}

test("Agent defaults to background: returns a placeholder, delivers one aggregated notification", async () => {
  const t = agentTool({ loader: loader(), spawn: echoSpawn });
  const { ctx, bg } = ctxWithBackground();
  const out = await t.execute(
    { tasks: [{ subagent_type: "general-purpose", prompt: "A" }, { subagent_type: "general-purpose", prompt: "B" }] },
    ctx,
  );
  expect(out).toMatch(/^\[background:bg_/);
  expect(out).toContain("2 subagent");
  expect(bg.pending()).toBe(1); // one batch = one task
  await bg.waitNext(new AbortController().signal);
  const [c] = bg.takeCompleted();
  expect(c!.content).toContain("RESULT(A)");
  expect(c!.content).toContain("RESULT(B)");
});

test("Agent with run_in_background:false blocks and returns the aggregate directly", async () => {
  const t = agentTool({ loader: loader(), spawn: echoSpawn });
  const { ctx } = ctxWithBackground();
  const out = await t.execute(
    { tasks: [{ subagent_type: "general-purpose", prompt: "X" }], run_in_background: false },
    ctx,
  );
  expect(out).toContain("RESULT(X)");
  expect(out).not.toMatch(/^\[background:/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter lite-agent test -- agent-background`
Expected: FAIL — schema rejects `run_in_background`; the tool always runs synchronously.

- [ ] **Step 3: Refactor `agent.ts` — extract the batch into `runBatch`, dispatch on the flag**

In `packages/sdk/src/tools/agent.ts`, replace the whole `schema`/`execute` block (lines 42-89, from `schema: z.object({ tasks: z.array(TASK).min(1) }),` through the closing `},` of `execute`) with the following. The `runOne` body is copied verbatim from the current code — only the wrapping `runBatch` function and the trailing dispatch are new:

```ts
    schema: z.object({
      tasks: z.array(TASK).min(1),
      run_in_background: z.boolean().optional().default(true),
    }),
    execute: async ({ tasks, run_in_background }, ctx) => {
      // Each entry in `tasks` is one subagent. Surface it as an ordinary tool
      // call (a tool_use + tool_result pair, paired by id) so any UI that already
      // renders tool calls shows N distinct subagents — no bespoke event type.
      const runBatch = async (): Promise<string> => {
        const runOne = async (t: z.infer<typeof TASK>): Promise<{ id: string; out: string }> => {
          const name = t.subagent_type.replace(/[\r\n]+/g, " ");
          const def = loader.get(t.subagent_type);
          if (!def) {
            const id = `agent-${sanitize(t.subagent_type) || "unknown"}-${shortId()}`;
            const out = `Error: unknown subagent_type '${name}'. Available: ${
              loader.names().join(", ") || "(none)"
            }`;
            ctx.emit({ type: "tool_use", call: { id, name, input: { prompt: t.prompt } } });
            ctx.emit({ type: "tool_result", result: { id, name, content: out, isError: true } });
            return { id: "-", out };
          }
          const sessionId = t.resume
            ? sanitize(t.resume)
            : `agent-${sanitize(t.subagent_type)}-${shortId()}`;
          ctx.emit({ type: "tool_use", call: { id: sessionId, name, input: { prompt: t.prompt } } });
          try {
            const out = await spawn(def, t.prompt, {
              signal: ctx.signal,
              sessionId,
              onEvent: (e) => ctx.emit({ ...e, agentId: sessionId }),
            });
            ctx.emit({ type: "tool_result", result: { id: sessionId, name, content: out } });
            return { id: sessionId, out };
          } catch (e) {
            const out = `Error: ${(e as Error).message}`;
            ctx.emit({ type: "tool_result", result: { id: sessionId, name, content: out, isError: true } });
            return { id: sessionId, out };
          }
        };

        const limit = pLimit(MAX_CONCURRENCY);
        const results = await Promise.all(tasks.map((t) => limit(() => runOne(t))));
        return results
          .map((r, i) => `## subagent[${i}] ${tasks[i]!.subagent_type.replace(/[\r\n]+/g, " ")} (agentId: ${r.id})\n${r.out}`)
          .join("\n\n");
      };

      if (run_in_background && ctx.background) {
        const h = ctx.background.spawn({ label: `${tasks.length} subagent(s)`, run: () => runBatch() });
        return `[background:${h.id}] dispatched ${tasks.length} subagent(s). Aggregated results will be delivered when all complete.`;
      }
      return runBatch();
    },
```

Note: `runOne` is unchanged. When backgrounded, `ctx.emit` inside `runOne` is the same run-level emit the registry forwards to, so subagent events still surface at turn-boundary drains. One batch → one `ctx.background.spawn` → one aggregated notification.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter lite-agent test -- agent-background`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing subagent tests (regression)**

Run: `pnpm --filter lite-agent test -- agent`
Expected: PASS — the default flip to background changes the *return string* for callers that relied on synchronous aggregation. If an existing test asserts the old synchronous aggregate, update it to pass `run_in_background: false` (the batch logic is byte-identical in that path). List any such test in the commit body.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/tools/agent.ts packages/sdk/test/agent-background.test.ts
git commit -m "feat(sdk): Agent run_in_background (default on), one batch = one notification"
```

---

## Task 7: `KillBackground` tool + `createLiteAgent`/`query` wiring (sdk)

**Files:**
- Create: `packages/sdk/src/tools/killBackground.ts`
- Modify: `packages/sdk/src/createLiteAgent.ts`
- Modify: `packages/sdk/src/query.ts`
- Test: `packages/sdk/test/kill-background.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/kill-background.test.ts`:

```ts
import { expect, test } from "vitest";
import { killBackgroundTool } from "../src/tools/killBackground";
import { createBackgroundTasks } from "@lite-agent/core";
import type { AgentEvent, ToolContext } from "@lite-agent/core";

test("KillBackground cancels a running task by id", async () => {
  const bg = createBackgroundTasks({ emit: (_e: AgentEvent) => {}, signal: new AbortController().signal });
  const h = bg.spawn({ label: "x", run: (signal) => new Promise<string>((r) => signal.addEventListener("abort", () => r("stopped"))) });
  const t = killBackgroundTool();
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: () => {}, background: bg } as ToolContext;
  const out = await t.execute({ id: h.id }, ctx);
  expect(out).toContain(h.id);
  await bg.waitNext(new AbortController().signal);
  expect(bg.pending()).toBe(0);
});

test("KillBackground reports an unknown id", async () => {
  const bg = createBackgroundTasks({ emit: (_e: AgentEvent) => {}, signal: new AbortController().signal });
  const t = killBackgroundTool();
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: () => {}, background: bg } as ToolContext;
  const out = await t.execute({ id: "bg_nope" }, ctx);
  expect(out).toContain("No running background task");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter lite-agent test -- kill-background`
Expected: FAIL — module `killBackground` not found.

- [ ] **Step 3: Write the tool**

Create `packages/sdk/src/tools/killBackground.ts`:

```ts
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";

export function killBackgroundTool(): Tool {
  return defineTool({
    name: "KillBackground",
    description:
      "Cancel a running background task by its id (the bg_… id reported when it started). Use this to stop a background command or subagent batch that is hung or no longer needed.",
    schema: z.object({ id: z.string() }),
    execute: async ({ id }, ctx) => {
      if (!ctx.background) return "Background tasks are disabled.";
      return ctx.background.cancel(id)
        ? `Cancelled ${id}.`
        : `No running background task with id '${id}'.`;
    },
  });
}
```

- [ ] **Step 4: Add `background` option to `CreateLiteAgentConfig` and register the tool**

In `packages/sdk/src/createLiteAgent.ts`:

Add the import near the other tool imports (after line 51's `agentTool` import):

```ts
import { killBackgroundTool } from "./tools/killBackground";
```

Add the config field to `interface CreateLiteAgentConfig` (after the `agents?` block, near line 98):

```ts
  /** Non-blocking background tasks (bash run_in_background + background subagents) + KillBackground tool. Default true. */
  background?: boolean;
```

Register the tool — add after the subagents block closes (after line 223, before `if (cfg.tools)`):

```ts
  if (cfg.background !== false) tools.push(killBackgroundTool());
```

Pass `background` into `createAgent` — in the `createAgent({ ... })` call, add after the `maxParallelTools` line (line 304):

```ts
    background: cfg.background,
```

- [ ] **Step 5: Add `background` passthrough to `query`**

In `packages/sdk/src/query.ts`:

Add to `interface QueryOptions` (after the `agents?` line, near line 52):

```ts
  background?: boolean;
```

Add to the `createLiteAgent({ ... })` call (after the `agents: opts.agents,` line, near line 91):

```ts
    background: opts.background,
```

- [ ] **Step 6: Rebuild core, run the sdk suite**

Run: `pnpm --filter @lite-agent/core build && pnpm --filter lite-agent test -- kill-background`
Expected: PASS (2 tests).

- [ ] **Step 7: Verify sdk typecheck**

Run: `pnpm --filter lite-agent typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/tools/killBackground.ts packages/sdk/src/createLiteAgent.ts packages/sdk/src/query.ts packages/sdk/test/kill-background.test.ts
git commit -m "feat(sdk): KillBackground tool + background option wiring"
```

---

## Task 8: Full-workspace verification

**Files:** none (verification only).

- [ ] **Step 1: Build, test, and typecheck the whole workspace**

Run: `pnpm -r build && pnpm -r test && pnpm -r typecheck`
Expected: All packages PASS. `pnpm -r` builds in topological order so the sdk sees the rebuilt core.

- [ ] **Step 2: If anything fails, fix and re-run**

Common failure: an existing `agent` test that asserted the old synchronous Agent aggregate (see Task 6, Step 5). Fix by adding `run_in_background: false` to that test's tool input.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "test: adjust for Agent background default"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** primitive (Task 1) · event + ctx/config types (Task 2) · kernel join + injection + abort + maxTurns exemption (Task 3) · createAgent passthrough (Task 4) · bash foreground-default (Task 5) · Agent background-default + one-batch-one-notification (Task 6) · KillBackground + top-level `background` switch + query passthrough (Task 7) · non-goals need no tasks.
- **Persistence:** the placeholder is a normal `tool_result` event and the injected notification is a normal `user` event — both persist through the existing `append(...)` calls with no checkpointer change (spec §Persistence). No task needed.
- **maxTurns exemption** is realized by `turn--` in the dry-out join branch (Task 3, Step 6); the test in Task 3 Step 1 (`maxTurns: 2`) guards it.
- **Type names are consistent across tasks:** `BackgroundTasks`, `BackgroundHandle`, `BackgroundCompletion`, `BackgroundSpawnOptions`, `createBackgroundTasks`, `backgroundNote`, `killBackgroundTool`, and the `run_in_background` schema key are used identically everywhere they appear.
