# Session-Scoped Background Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let explicit background Bash and subagent work outlive the `run()` that spawned it, accept later user turns, and automatically wake the originating `LiteAgent` session on completion while ordinary `Agent` calls remain blocking.

**Architecture:** Core gains an optional externally owned `BackgroundTasks` resolver while preserving its current per-run default. The SDK adds a per-session runner that serializes user jobs and completion jobs, owns background registries, publishes a long-lived event stream through `subscribe()`, and closes tasks explicitly through `close()`.

**Tech Stack:** TypeScript 6 strict ESM, async generators, Vitest, pnpm 10.12.4, existing `@lite-agent/core` background/checkpointer primitives.

## Global Constraints

- Keep `Agent` blocking by default; only `run_in_background: true` detaches it from the current run.
- Never execute two core runs concurrently for the same `sessionId`.
- Background work survives later turns only inside the same live `LiteAgent` process; no restartable Promise/process supervision.
- Completion messages must use the existing `<background-task-completed>` format and enter the normal checkpointer/context path.
- Do not rewrite or append to the protected static prompt prefix; notifications are dynamic user messages.
- Preserve `run()` and `send()` signatures and one-shot event behavior.
- `query()` remains finite and must close its temporary agent in `finally`.
- Add no dependency; use the repository's existing primitives and style.
- Build `@lite-agent/core` before testing or typechecking the dependent SDK.
- Touch only core, SDK, their tests/docs, and their release metadata.

---

## File map

- `packages/core/src/background.ts` — completion callback and canonical completion-message formatter.
- `packages/core/src/kernel.ts` — owned versus externally supplied background registry behavior.
- `packages/core/src/createAgent.ts` — public resolver seam forwarded to the kernel.
- `packages/core/src/index.ts` — exports for the new core types/helper.
- `packages/sdk/src/sessionRunner.ts` — per-session serialization, registries, completion wake-up, subscriptions, and close lifecycle.
- `packages/sdk/src/liteAgentAssembly.ts` — passes the session registry resolver into core assembly.
- `packages/sdk/src/createLiteAgent.ts` — constructs one session runner per `LiteAgent`; closes child agents.
- `packages/sdk/src/liteAgent.ts` — binds core execution to the runner and exposes `subscribe()` / `close()`.
- `packages/sdk/src/tools/agent.ts` — explicit background subagents become detached session work.
- `packages/sdk/src/tools/bash.ts` — session-lifetime tool description.
- `packages/sdk/src/query.ts` — closes the temporary one-shot agent.
- `packages/sdk/src/index.ts` — exports `LiteAgentEvent`.
- `packages/core/test/background.test.ts`, `packages/core/test/kernel-background.test.ts` — core lifecycle regression tests.
- `packages/sdk/test/session-runner.test.ts` — scheduler unit tests.
- `packages/sdk/test/session-background.test.ts`, `packages/sdk/test/agent-background.test.ts`, `packages/sdk/test/query.test.ts` — SDK integration and compatibility tests.
- `packages/sdk/README.md`, `packages/sdk/README.zh-CN.md` — interactive subscription examples and lifecycle documentation.

---

### Task 1: Canonical completion notification and completion callback

**Files:**
- Modify: `packages/core/src/background.ts`
- Modify: `packages/core/src/kernel.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/background.test.ts`

**Interfaces:**
- Consumes: existing `BackgroundCompletion`, `BackgroundTasks.takeCompleted()`.
- Produces: `BackgroundDeps.onCompleted?: (completion: BackgroundCompletion) => void` and `backgroundCompletionMessage(completion): Message`.

- [ ] **Step 1: Write failing callback and formatter tests**

Add the import and tests to `packages/core/test/background.test.ts`:

```ts
import { backgroundCompletionMessage, createBackgroundTasks } from "../src/background";

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
```

- [ ] **Step 2: Run the core test and verify RED**

Run:

```bash
pnpm --filter @lite-agent/core test -- background.test.ts
```

Expected: TypeScript/Vitest fails because `backgroundCompletionMessage` and `BackgroundDeps.onCompleted` do not exist.

- [ ] **Step 3: Add the callback and formatter**

In `packages/core/src/background.ts`, import `Message`, add the callback, invoke it after queueing, and export the formatter:

```ts
import type { Message } from "./types";

export interface BackgroundDeps {
  emit: (e: AgentEvent) => void;
  signal: AbortSignal;
  limits?: BackgroundLimits;
  onCompleted?: (completion: BackgroundCompletion) => void;
}

const finish = (id: string, label: string, content: string, isError: boolean) => {
  if (!running.has(id)) return;
  running.delete(id);
  const d = detached.get(id);
  if (d) d.done = true;
  const completion = { id, label, content, isError };
  completed.push(completion);
  notify();
  deps.onCompleted?.(completion);
};

export function backgroundCompletionMessage(c: BackgroundCompletion): Message {
  const status = c.isError ? ' status="error"' : "";
  const label = c.label.replace(/"/g, "'");
  return {
    role: "user",
    content:
      `<background-task-completed id="${c.id}" label="${label}"${status}>\n` +
      `${c.content}\n</background-task-completed>`,
  };
}
```

Replace the private `backgroundNote()` in `packages/core/src/kernel.ts` with the exported helper, then delete the private function:

```ts
import { backgroundCompletionMessage, createBackgroundTasks } from "./background";

const note = backgroundCompletionMessage(c);
```

Export the helper and `BackgroundDeps` from `packages/core/src/index.ts`:

```ts
export { backgroundCompletionMessage, createBackgroundTasks } from "./background";
export type {
  BackgroundTasks, BackgroundHandle, BackgroundCompletion, BackgroundSpawnOptions,
  BackgroundKind, BackgroundRead, BackgroundDeps, BackgroundLimits,
} from "./background";
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @lite-agent/core test -- background.test.ts
```

Expected: all background registry tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/core/src/background.ts packages/core/src/kernel.ts packages/core/src/index.ts packages/core/test/background.test.ts
git commit -m "feat(core): expose background completion notifications"
```

---

### Task 2: Externally owned background registry seam in core

**Files:**
- Modify: `packages/core/src/createAgent.ts`
- Modify: `packages/core/src/kernel.ts`
- Test: `packages/core/test/kernel-background.test.ts`

**Interfaces:**
- Consumes: `BackgroundTasks` from Task 1.
- Produces: `backgroundTasks?: (sessionId: string) => BackgroundTasks | undefined` on `CreateAgentConfig` and `KernelConfig`.

- [ ] **Step 1: Write the failing external-ownership regression**

Add to `packages/core/test/kernel-background.test.ts`:

```ts
test("an externally owned detached registry survives kernel run-end", async () => {
  const lifecycle = new AbortController();
  let release!: () => void;
  const external = createBackgroundTasks({ emit: () => {}, signal: lifecycle.signal });
  const tool = defineTool({
    name: "external_bg",
    description: "start external background work",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      ctx.background!.spawn({
        label: "external",
        kind: "detached",
        run: () => new Promise<string>((resolve) => { release = () => resolve("done"); }),
      });
      return "started";
    },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "external_bg", input: {} }] } },
    { text: "idle", message: { role: "assistant", content: [textBlock("idle")] } },
  ]);

  await drain(runKernel(baseCfg({
    provider,
    tools: [tool],
    backgroundTasks: (sessionId) => sessionId === "s1" ? external : undefined,
  }), "go", new AbortController().signal, "s1"));

  expect(external.pendingDetached()).toBe(1);
  release();
  for (let i = 0; i < 20 && !external.hasCompleted(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(external.takeCompleted()[0]?.content).toBe("done");
});
```

Also import `createBackgroundTasks` in that test file.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm --filter @lite-agent/core test -- kernel-background.test.ts
```

Expected: compile failure because `KernelConfig.backgroundTasks` is unknown.

- [ ] **Step 3: Add the resolver to core configuration**

In `packages/core/src/createAgent.ts` and `packages/core/src/kernel.ts`, add:

```ts
import type { BackgroundLimits, BackgroundTasks } from "./background";

/** Resolve externally owned background work for a session. Omit for per-run ownership. */
backgroundTasks?: (sessionId: string) => BackgroundTasks | undefined;
```

Forward it in `createAgent()`:

```ts
background: cfg.background,
backgroundLimits: cfg.backgroundLimits,
backgroundTasks: cfg.backgroundTasks,
```

- [ ] **Step 4: Make kernel cleanup conditional on ownership**

Replace registry construction in `runKernel()` with:

```ts
const suppliedBackground = cfg.backgroundTasks?.(sessionId);
const ownsBackground = suppliedBackground === undefined && cfg.background !== false;
const bg = suppliedBackground ?? (cfg.background === false
  ? undefined
  : createBackgroundTasks({ emit, signal, limits: cfg.backgroundLimits }));
```

Gate every run-local action:

```ts
if (signal.aborted) {
  if (ownsBackground) bg?.cancelAll();
  stopReason = "aborted";
  break;
}

if (ownsBackground && bg) {
  for (const c of bg.takeCompleted()) {
    const note = backgroundCompletionMessage(c);
    ctx.messages.push(note);
    await append({ type: "user", message: note });
    yield { type: "background_completed", completion: c };
  }
}

if (ownsBackground && bg && (bg.pendingJoinable() > 0 || bg.hasCompleted())) {
  yield { type: "turn_end", turn, stopReason: "stop" };
  if (!bg.hasCompleted()) await bg.waitNextJoinable(signal);
  turn--;
  continue;
}

if (ownsBackground) bg?.cancelAll();
// and in finally:
if (ownsBackground) bg?.cancelAll();
```

Externally supplied registries are still passed to tool contexts; they are only excluded from run-local drain, join, and cancellation.

- [ ] **Step 5: Verify core background behavior**

Run:

```bash
pnpm --filter @lite-agent/core test -- kernel-background.test.ts background.test.ts
pnpm --filter @lite-agent/core typecheck
```

Expected: all tests pass and typecheck exits 0. Existing internal join/cancel tests must remain green.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/core/src/createAgent.ts packages/core/src/kernel.ts packages/core/test/kernel-background.test.ts
git commit -m "feat(core): support externally owned background tasks"
```

---

### Task 3: Per-session runner and long-lived event publisher

**Files:**
- Create: `packages/sdk/src/sessionRunner.ts`
- Create: `packages/sdk/test/session-runner.test.ts`

**Interfaces:**
- Consumes: `createBackgroundTasks`, `backgroundCompletionMessage`, `BackgroundTasks`, `BackgroundLimits`, `AgentEvent`, `Message`, `RunOptions`, and `RunResult` from core.
- Produces: `LiteAgentEvent`, `SessionRun<R>`, `SessionRunner<R>`, and `createSessionRunner<R>()`.

- [ ] **Step 1: Write scheduler tests before implementation**

Create `packages/sdk/test/session-runner.test.ts` with a scripted `SessionRun<RunResult>` and these cases:

```ts
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
  await vi.waitFor(() => expect(events.some((e) =>
    e.source === "background" && e.event.type === "done",
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
  runner.backgroundTasks("s1")!.spawn({ label: "job", kind: "detached", run: async () => "done" });
  await new Promise((r) => setTimeout(r, 5));
  expect(order).toEqual(["user"]);
  releaseUser();
  await draining;
  await vi.waitFor(() => expect(order).toEqual(["user", "background"]));
  expect(maxActive).toBe(1);
  await runner.close();
});
```

Add the batching, listener isolation, cancellation, and close cases in the same file:

```ts
test("ready completions are batched into one background run", async () => {
  const inputs: Message[][] = [];
  const runner = createSessionRunner<RunResult>({ background: true });
  runner.bind(async function* (input) {
    inputs.push(input as Message[]);
    yield { type: "done", reason: "stop", result: result("ok") };
    return result("ok");
  });
  const bg = runner.backgroundTasks("s1")!;
  bg.spawn({ label: "one", kind: "detached", run: async () => "ONE" });
  bg.spawn({ label: "two", kind: "detached", run: async () => "TWO" });
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  expect(inputs[0]).toHaveLength(2);
  expect(inputs[0]!.map((m) => String(m.content)).join("\n")).toContain("ONE");
  expect(inputs[0]!.map((m) => String(m.content)).join("\n")).toContain("TWO");
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
  const bg = runner.backgroundTasks("s1")!;
  bg.spawn({
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

test("close is idempotent and rejects later runs", async () => {
  const runner = createSessionRunner<RunResult>({ background: false });
  runner.bind(async function* () { return result("ok"); });
  await runner.close();
  await runner.close();
  const stream = runner.run("late", { sessionId: "s1" });
  await expect(stream.next()).rejects.toThrow("LiteAgent is closed");
});
```

- [ ] **Step 2: Run the new test and verify RED**

First build core because SDK resolves `@lite-agent/core` through `dist`:

```bash
pnpm --filter @lite-agent/core build
pnpm --filter @lite-agent/sdk test -- session-runner.test.ts
```

Expected: failure because `../src/sessionRunner` does not exist.

- [ ] **Step 3: Define the runner interfaces**

Create `packages/sdk/src/sessionRunner.ts` with these public/internal contracts:

```ts
import {
  AgentError,
  backgroundCompletionMessage,
  createBackgroundTasks,
} from "@lite-agent/core";
import type {
  AgentEvent,
  BackgroundLimits,
  BackgroundTasks,
  Message,
  RunOptions,
  RunResult,
} from "@lite-agent/core";

export interface LiteAgentEvent {
  sessionId: string;
  source: "user" | "background";
  event: AgentEvent;
}

export type SessionRun<R extends RunResult> = (
  input: string | Message[],
  opts: RunOptions & { sessionId: string },
) => AsyncGenerator<AgentEvent, R>;

export interface SessionRunner<R extends RunResult> {
  bind(run: SessionRun<R>): void;
  run(input: string | Message[], opts: RunOptions & { sessionId: string }): AsyncGenerator<AgentEvent, R>;
  backgroundTasks(sessionId: string): BackgroundTasks | undefined;
  subscribe(listener: (entry: LiteAgentEvent) => void): () => void;
  cancelSession(sessionId: string): void;
  close(): Promise<void>;
}

export interface SessionRunnerOptions {
  background: boolean;
  limits?: BackgroundLimits;
}
```

- [ ] **Step 4: Implement serialization, completion scheduling, and lifecycle**

Implement `createSessionRunner<R>()` in the same file with these exact invariants:

```ts
export function createSessionRunner<R extends RunResult>(
  opts: SessionRunnerOptions,
): SessionRunner<R> {
  type Scope = { active: boolean; abort: AbortController; tasks: BackgroundTasks };
  const scopes = new Map<string, Scope>();
  const tails = new Map<string, Promise<void>>();
  const scheduled = new Set<string>();
  const listeners = new Set<(entry: LiteAgentEvent) => void>();
  let execute: SessionRun<R> | undefined;
  let closed = false;

  const publish = (entry: LiteAgentEvent) => {
    if (closed) return;
    for (const listener of listeners) {
      try { listener(entry); } catch { /* observational */ }
    }
  };

  const acquire = async (sessionId: string): Promise<() => void> => {
    const previous = tails.get(sessionId) ?? Promise.resolve();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const tail = previous.then(() => gate);
    tails.set(sessionId, tail);
    await previous;
    return () => {
      open();
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
    };
  };

  const requireExecute = (): SessionRun<R> => {
    if (closed) throw new AgentError("LiteAgent is closed");
    if (!execute) throw new AgentError("LiteAgent session runner is not bound");
    return execute;
  };

  const drain = async (
    sessionId: string,
    source: LiteAgentEvent["source"],
    input: string | Message[],
    runOpts: RunOptions,
  ): Promise<R> => {
    const gen = requireExecute()(input, { ...runOpts, sessionId });
    let next = await gen.next();
    try {
      while (!next.done) {
        publish({ sessionId, source, event: next.value });
        next = await gen.next();
      }
      return next.value;
    } finally {
      if (!next.done) await gen.return(undefined as R);
    }
  };

  const schedule = (sessionId: string, scope: Scope) => {
    if (closed || !scope.active || scheduled.has(sessionId)) return;
    scheduled.add(sessionId);
    queueMicrotask(() => {
      void runCompletions(sessionId, scope).catch((error) => {
        const agentError = error instanceof AgentError ? error : new AgentError(String(error));
        publish({ sessionId, source: "background", event: { type: "error", error: agentError, fatal: true } });
      });
    });
  };

  const runCompletions = async (sessionId: string, scope: Scope) => {
    const release = await acquire(sessionId);
    try {
      if (closed || !scope.active || scopes.get(sessionId) !== scope) return;
      const completions = scope.tasks.takeCompleted();
      if (completions.length === 0) return;
      for (const completion of completions) {
        publish({ sessionId, source: "background", event: { type: "background_completed", completion } });
      }
      await drain(
        sessionId,
        "background",
        completions.map(backgroundCompletionMessage),
        {},
      );
    } finally {
      release();
      scheduled.delete(sessionId);
      if (!closed && scope.active && scope.tasks.hasCompleted()) schedule(sessionId, scope);
    }
  };
```

Finish the returned object without adding another abstraction:

```ts
  const backgroundTasks = (sessionId: string): BackgroundTasks | undefined => {
    if (!opts.background || closed) return undefined;
    const existing = scopes.get(sessionId);
    if (existing) return existing.tasks;
    const abort = new AbortController();
    let scope!: Scope;
    const tasks = createBackgroundTasks({
      emit: (event) => publish({ sessionId, source: "background", event }),
      signal: abort.signal,
      limits: opts.limits,
      onCompleted: () => schedule(sessionId, scope),
    });
    scope = { active: true, abort, tasks };
    scopes.set(sessionId, scope);
    return tasks;
  };

  return {
    bind(run) {
      if (execute) throw new AgentError("LiteAgent session runner is already bound");
      execute = run;
    },
    run(input, runOpts) {
      const sessionId = runOpts.sessionId;
      return (async function* () {
        const release = await acquire(sessionId);
        let gen: AsyncGenerator<AgentEvent, R> | undefined;
        let next: IteratorResult<AgentEvent, R> | undefined;
        try {
          gen = requireExecute()(input, { ...runOpts, sessionId });
          next = await gen.next();
          while (!next.done) {
            publish({ sessionId, source: "user", event: next.value });
            yield next.value;
            next = await gen.next();
          }
          return next.value;
        } finally {
          if (gen && next && !next.done) await gen.return(undefined as R);
          release();
        }
      })();
    },
    backgroundTasks,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancelSession(sessionId) {
      const scope = scopes.get(sessionId);
      if (!scope) return;
      scope.active = false;
      scopes.delete(sessionId);
      scope.abort.abort();
      scope.tasks.cancelAll();
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const [sessionId] of scopes) this.cancelSession(sessionId);
      listeners.clear();
    },
  };
}
```

- [ ] **Step 5: Run scheduler tests and verify GREEN**

Run:

```bash
pnpm --filter @lite-agent/sdk test -- session-runner.test.ts
pnpm --filter @lite-agent/sdk typecheck
```

Expected: all new scheduler tests pass, `maxActive` remains 1, and typecheck exits 0.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/sdk/src/sessionRunner.ts packages/sdk/test/session-runner.test.ts
git commit -m "feat(sdk): add session background runner"
```

---

### Task 4: Bind the session runner into `LiteAgent`

**Files:**
- Modify: `packages/sdk/src/liteAgentAssembly.ts`
- Modify: `packages/sdk/src/createLiteAgent.ts`
- Modify: `packages/sdk/src/liteAgent.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/sessions.test.ts`
- Test: `packages/sdk/test/createLiteAgent.test.ts`

**Interfaces:**
- Consumes: `SessionRunner<LiteAgentResult>` and core `backgroundTasks` resolver.
- Produces: public `LiteAgent.subscribe(listener)` and `LiteAgent.close()`.

- [ ] **Step 1: Add failing public API/lifecycle tests**

Add tests that assert:

```ts
test("LiteAgent publishes user-run events through subscribe", async () => {
  const agent = createLiteAgent({
    model: reply("ok"),
    workdir: freshWorkdir(),
    sessions: false,
    cleanup: false,
  });
  const seen: string[] = [];
  const unsubscribe = agent.subscribe(({ sessionId, source, event }) => {
    if (event.type === "done") seen.push(`${sessionId}:${source}:${event.reason}`);
  });
  await agent.send("hello", { sessionId: "subscribed" });
  expect(seen).toEqual(["subscribed:user:stop"]);
  unsubscribe();
  await agent.close();
  await expect(agent.send("again")).rejects.toThrow("LiteAgent is closed");
});
```

Keep the existing test `run captures the current session before its first next call` unchanged and green.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm --filter @lite-agent/core build
pnpm --filter @lite-agent/sdk test -- sessions.test.ts createLiteAgent.test.ts
```

Expected: compile failures because `subscribe()` and `close()` are absent.

- [ ] **Step 3: Pass the resolver through assembly**

Extend `AssembleLiteAgentOptions` in `packages/sdk/src/liteAgentAssembly.ts`:

```ts
import type { BackgroundTasks, Checkpointer, Compactor, Middleware, Tool } from "@lite-agent/core";

interface AssembleLiteAgentOptions {
  readonly cfg: CreateLiteAgentConfig;
  readonly paths: ProjectPaths;
  readonly spawn: Spawn;
  readonly backgroundTasks: (sessionId: string) => BackgroundTasks | undefined;
}
```

Destructure it and pass it to `createAgent({ backgroundTasks })`.

- [ ] **Step 4: Construct the runner before assembly**

In `packages/sdk/src/createLiteAgent.ts`:

```ts
import { createSessionRunner } from "./sessionRunner";
import type { CreateLiteAgentConfig, LiteAgent, LiteAgentResult } from "./liteAgent";

const sessions = createSessionRunner<LiteAgentResult>({
  background: cfg.background !== false,
  limits: cfg.backgroundLimits,
});

const runtime = assembleLiteAgent({
  cfg,
  paths,
  spawn,
  backgroundTasks: (sessionId) => sessions.backgroundTasks(sessionId),
});
return createLiteAgentFacade(runtime, cfg.workdir, sessions);
```

Change the child spawn closure to close its recursively created child:

```ts
try {
  const gen = child.run([{ role: "user", content: prompt }], { signal, sessionId });
  let result = await gen.next();
  while (!result.done) {
    onEvent?.(result.value);
    result = await gen.next();
  }
  return result.value.text;
} finally {
  await child.close();
}
```

- [ ] **Step 5: Bind core execution and expose lifecycle methods**

Change `createLiteAgentFacade()` to receive the runner, bind exactly once, and route user calls through it:

```ts
export function createLiteAgentFacade(
  runtime: LiteAgentRuntime,
  workdir: string,
  sessions: SessionRunner<LiteAgentResult>,
): LiteAgent {
  let currentSessionId = newSessionId();

  sessions.bind((input, opts) => {
    const gen = runtime.core.run(input, opts);
    const takeOutput = runtime.takeOutput;
    if (!takeOutput) return gen;
    return (async function* () {
      let result = await gen.next();
      while (!result.done) {
        yield result.value;
        result = await gen.next();
      }
      return { ...result.value, output: takeOutput(opts.sessionId) };
    })();
  });

  const run = (input: string | Message[], opts?: RunOptions) => {
    const sessionId = opts?.sessionId ?? currentSessionId;
    return sessions.run(input, { ...opts, sessionId });
  };
```

Import the runner types, re-export the event envelope, and add these members to
the existing public interface and returned object:

```ts
import type { LiteAgentEvent, SessionRunner } from "./sessionRunner";
export type { LiteAgentEvent } from "./sessionRunner";

export interface LiteAgent extends Agent {
  subscribe(listener: (entry: LiteAgentEvent) => void): () => void;
  close(): Promise<void>;
}

subscribe: (listener) => sessions.subscribe(listener),
close: () => sessions.close(),
deleteSession: async (id) => {
  if (!runtime.checkpointer) return noSessions();
  sessions.cancelSession(id);
  await runtime.checkpointer.delete(id);
  runtime.context?.remove?.(id);
  runtime.context?.invalidate(id);
},
```

Export `LiteAgentEvent` through `createLiteAgent.ts` and `packages/sdk/src/index.ts`.

- [ ] **Step 6: Verify facade and session regressions**

Run:

```bash
pnpm --filter @lite-agent/sdk test -- sessions.test.ts createLiteAgent.test.ts session-runner.test.ts
pnpm --filter @lite-agent/sdk typecheck
```

Expected: all focused tests pass, including session capture, resume, clear, delete, structured output, subscribe, and close.

- [ ] **Step 7: Commit Task 4**

```bash
git add packages/sdk/src/liteAgentAssembly.ts packages/sdk/src/createLiteAgent.ts packages/sdk/src/liteAgent.ts packages/sdk/src/index.ts packages/sdk/test/sessions.test.ts packages/sdk/test/createLiteAgent.test.ts
git commit -m "feat(sdk): bind background work to LiteAgent sessions"
```

---

### Task 5: Tool policy, automatic wake-up integration, and one-shot cleanup

**Files:**
- Modify: `packages/sdk/src/tools/agent.ts`
- Modify: `packages/sdk/src/tools/bash.ts`
- Modify: `packages/sdk/src/query.ts`
- Modify: `packages/sdk/test/agent-background.test.ts`
- Create: `packages/sdk/test/session-background.test.ts`
- Modify: `packages/sdk/test/query.test.ts`

**Interfaces:**
- Consumes: the session-bound registry and event publisher from Tasks 3-4.
- Produces: complete user-visible background behavior and finite `query()` cleanup.

- [ ] **Step 1: Change the direct Agent tool test to require detached execution**

In `packages/sdk/test/agent-background.test.ts`, add `vi` to the Vitest import
and replace the background test with:

```ts
import { expect, test, vi } from "vitest";

test("Agent with run_in_background:true backgrounds as one detached task", async () => {
  const t = agentTool({ loader: loader(), spawn: echoSpawn });
  const { ctx, bg } = ctxWithBackground();
  const out = await t.execute({
    tasks: [
      { subagent_type: "general-purpose", prompt: "A" },
      { subagent_type: "general-purpose", prompt: "B" },
    ],
    run_in_background: true,
  }, ctx);
  expect(out).toMatch(/^\[background:bg_/);
  expect(bg.pendingDetached()).toBe(1);
  expect(bg.pendingJoinable()).toBe(0);
  await vi.waitFor(() => expect(bg.hasCompleted()).toBe(true));
  const [completion] = bg.takeCompleted();
  expect(completion!.content).toContain("RESULT(A)");
  expect(completion!.content).toContain("RESULT(B)");
});
```

Keep the default-blocking test unchanged.

- [ ] **Step 2: Write the end-to-end cross-turn regression**

Create `packages/sdk/test/session-background.test.ts`. Use a custom tool with a deferred detached task and a scripted provider:

```ts
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { defineTool, fakeProvider, memoryCheckpointer, textBlock } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import type { LiteAgentEvent } from "../src/liteAgent";

test("background completion wakes the idle session without blocking later user input", async () => {
  let finish!: () => void;
  const background = defineTool({
    name: "background_probe",
    description: "start deferred work",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      const handle = ctx.background!.spawn({
        label: "probe",
        kind: "detached",
        run: () => new Promise<string>((resolve) => { finish = () => resolve("PROBE DONE"); }),
      });
      return `[background:${handle.id}] started`;
    },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "p1", name: "background_probe", input: {} }] } },
    { text: "spawned", message: { role: "assistant", content: [textBlock("spawned")] } },
    { text: "user answer", message: { role: "assistant", content: [textBlock("user answer")] } },
    { text: "background answer", message: { role: "assistant", content: [textBlock("background answer")] } },
  ]);
  const checkpointer = memoryCheckpointer();
  const agent = createLiteAgent({
    model: provider,
    workdir: process.cwd(),
    tools: [background],
    checkpointer,
    tasks: false,
    cleanup: false,
  });
  const seen: LiteAgentEvent[] = [];
  agent.subscribe((entry) => seen.push(entry));

  expect((await agent.send("start", { sessionId: "main" })).text).toBe("spawned");
  expect((await agent.send("question", { sessionId: "main" })).text).toBe("user answer");
  finish();
  await vi.waitFor(() => expect(seen.some((entry) =>
    entry.sessionId === "main" && entry.source === "background" &&
    entry.event.type === "done",
  )).toBe(true));

  const stored = [];
  for await (const entry of checkpointer.read("main")) stored.push(entry);
  expect(stored.some((entry) =>
    entry.event.type === "user" &&
    String(entry.event.message.content).includes("PROBE DONE"),
  )).toBe(true);
  await agent.close();
});
```

Add the session attribution, cross-turn output, and deletion regressions:

```ts
test("a completion remains attributed to its originating session after resume", async () => {
  let finish!: () => void;
  const tool = defineTool({
    name: "defer",
    description: "defer",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      ctx.background!.spawn({
        label: "A work",
        kind: "detached",
        run: () => new Promise<string>((resolve) => { finish = () => resolve("A DONE"); }),
      });
      return "started";
    },
  });
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "a1", name: "defer", input: {} }] } },
      { text: "A idle", message: { role: "assistant", content: [textBlock("A idle")] } },
      { text: "B answer", message: { role: "assistant", content: [textBlock("B answer")] } },
      { text: "A resumed", message: { role: "assistant", content: [textBlock("A resumed")] } },
    ]),
    workdir: process.cwd(),
    tools: [tool],
    tasks: false,
    cleanup: false,
  });
  const events: LiteAgentEvent[] = [];
  agent.subscribe((entry) => events.push(entry));
  await agent.send("start A", { sessionId: "A" });
  agent.resume("B");
  await agent.send("question B");
  finish();
  await vi.waitFor(() => expect(events.some((entry) =>
    entry.sessionId === "A" && entry.source === "background" && entry.event.type === "done",
  )).toBe(true));
  expect(events.some((entry) => entry.sessionId === "B" && entry.source === "background")).toBe(false);
  await agent.close();
});

test("a detached output buffer is readable from a later turn", async () => {
  let taskId = "";
  const start = defineTool({
    name: "start_stream",
    description: "start stream",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      const handle = ctx.background!.spawn({
        label: "stream",
        kind: "detached",
        run: (signal, _emit, write) => new Promise<string>((resolve) => {
          write("hello later\n");
          signal.addEventListener("abort", () => resolve("stopped"));
        }),
      });
      taskId = handle.id;
      return "streaming";
    },
  });
  const read = defineTool({
    name: "read_stream",
    description: "read stream",
    schema: z.object({}),
    execute: async (_input, ctx) => ctx.background!.read(taskId)?.output ?? "missing",
  });
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "s1", name: "start_stream", input: {} }] } },
      { text: "started", message: { role: "assistant", content: [textBlock("started")] } },
      { message: { role: "assistant", content: [{ type: "tool_call", id: "r1", name: "read_stream", input: {} }] } },
      { text: "read", message: { role: "assistant", content: [textBlock("read")] } },
    ]),
    workdir: process.cwd(),
    tools: [start, read],
    tasks: false,
    sessions: false,
    cleanup: false,
  });
  await agent.send("start");
  const contents: string[] = [];
  for await (const event of agent.run("read")) {
    if (event.type === "tool_result" && event.result.name === "read_stream") contents.push(event.result.content);
  }
  expect(contents).toEqual(["hello later\n"]);
  await agent.close();
});

test("deleteSession cancels work without a late autonomous turn", async () => {
  let aborted = false;
  const tool = defineTool({
    name: "until_abort",
    description: "until abort",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      ctx.background!.spawn({
        label: "deleted",
        kind: "detached",
        run: (signal) => new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => { aborted = true; resolve("cancelled"); });
        }),
      });
      return "started";
    },
  });
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "d1", name: "until_abort", input: {} }] } },
      { text: "idle", message: { role: "assistant", content: [textBlock("idle")] } },
    ]),
    workdir: process.cwd(),
    tools: [tool],
    checkpointer: memoryCheckpointer(),
    tasks: false,
    cleanup: false,
  });
  const backgroundDone = vi.fn();
  agent.subscribe((entry) => {
    if (entry.source === "background" && entry.event.type === "done") backgroundDone();
  });
  await agent.send("start", { sessionId: "delete-me" });
  await agent.deleteSession("delete-me");
  await vi.waitFor(() => expect(aborted).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(backgroundDone).not.toHaveBeenCalled();
  await agent.close();
});
```

In `packages/sdk/test/query.test.ts`, add `vi` to the Vitest import and add the
one-shot cleanup regression before changing `query()`:

```ts
import { expect, test, vi } from "vitest";

test("query closes detached work owned by its temporary LiteAgent", async () => {
  let aborted = false;
  const background = tool("query_background", "query background", z.object({}), async (_input, ctx) => {
    ctx.background!.spawn({
      label: "query task",
      kind: "detached",
      run: (signal) => new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => { aborted = true; resolve("cancelled"); });
      }),
    });
    return "started";
  });
  const stream = query({
    prompt: "start",
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "q1", name: "query_background", input: {} }] } },
      { text: "idle", message: { role: "assistant", content: [textBlock("idle")] } },
    ]),
    cwd: process.cwd(),
    tools: [background],
    sessions: false,
    tasks: false,
    agents: false,
    cleanup: false,
  });
  while (!(await stream.next()).done) {}
  await vi.waitFor(() => expect(aborted).toBe(true));
});
```

- [ ] **Step 3: Verify RED**

Run:

```bash
pnpm --filter @lite-agent/core build
pnpm --filter @lite-agent/sdk test -- agent-background.test.ts session-background.test.ts query.test.ts
```

Expected: Agent test fails because it is still joinable; integration fails because current run-end cancels/background completion cannot auto-wake; query cleanup test is not implemented.

- [ ] **Step 4: Apply the SDK tool policy changes**

In `packages/sdk/src/tools/agent.ts`:

```ts
if (run_in_background === true && ctx.background) {
  const handle = ctx.background.spawn({
    label: `${tasks.length} subagent(s)`,
    kind: "detached",
    run: (signal, emit) => runBatch(signal, emit),
  });
  return `[background:${handle.id}] dispatched ${tasks.length} subagent(s). Aggregated results will be delivered when all complete.`;
}
return runBatch();
```

Update its description to state that explicit background work survives later
turns of the same live session. In `bash.ts`, update both the tool description
and the returned `[background:...]` placeholder: replace “stopped automatically
when the run ends” with “continues across turns and is stopped by
`KillBackground`, session deletion, configured limits, or `LiteAgent.close()`.”
Do not change foreground behavior or schemas.

- [ ] **Step 5: Close one-shot query agents**

Keep the existing `createLiteAgent({...})` option forwarding unchanged. Replace
the final direct `return agent.run(...)` with this wrapper:

```ts
return (async function* () {
  const stream = agent.run(opts.prompt, {
    signal: opts.signal,
    sessionId: opts.sessionId,
    steer: opts.steer,
  });
  try {
    let next = await stream.next();
    while (!next.done) {
      yield next.value;
      next = await stream.next();
    }
    return next.value;
  } finally {
    await agent.close();
  }
})();
```

- [ ] **Step 6: Run the complete SDK background suite**

Run:

```bash
pnpm --filter @lite-agent/sdk test -- agent-background.test.ts session-background.test.ts bash-background.test.ts bash-output.test.ts kill-background.test.ts query.test.ts
pnpm --filter @lite-agent/sdk typecheck
```

Expected: all tests pass; the spawning run and later user turn finish before the deferred completion, then the completion produces a subscribed background-source `done` event.

- [ ] **Step 7: Commit Task 5**

```bash
git add packages/sdk/src/tools/agent.ts packages/sdk/src/tools/bash.ts packages/sdk/src/query.ts packages/sdk/test/agent-background.test.ts packages/sdk/test/session-background.test.ts packages/sdk/test/query.test.ts
git commit -m "feat(sdk): wake sessions on background completion"
```

---

### Task 6: Documentation, full verification, and release metadata

**Files:**
- Modify: `packages/sdk/README.md`
- Modify: `packages/sdk/README.zh-CN.md`
- Modify after verification via `version-and-changelog`: `packages/core/package.json`, `packages/core/CHANGELOG.md`, `packages/sdk/package.json`, `packages/sdk/CHANGELOG.md`

**Interfaces:**
- Consumes: final public `LiteAgent`, `LiteAgentEvent`, `subscribe()`, and `close()` behavior.
- Produces: documented lifecycle and package-scoped release metadata.

- [ ] **Step 1: Add the English interactive example**

Add after the stateful `createLiteAgent()` example in `packages/sdk/README.md`:

```ts
const unsubscribe = agent.subscribe(({ sessionId, source, event }) => {
  render(sessionId, source, event); // also receives autonomous background turns
});

await agent.send("Start the long review in the background");
await agent.send("Meanwhile, answer this separate question");

// On application shutdown:
unsubscribe();
await agent.close();
```

State explicitly: ordinary `Agent` calls block; `run_in_background: true` returns immediately; completion wakes the originating session; same-session jobs are serialized; in-flight tasks do not survive process restart; `query()` is one-shot and closes background work.

- [ ] **Step 2: Add the matching Chinese documentation**

Add the equivalent example and statements to `packages/sdk/README.zh-CN.md`, preserving API identifiers verbatim and translating only prose.

- [ ] **Step 3: Run fresh full verification before claiming completion**

Run from the repository root:

```bash
pnpm -r build
pnpm -r test
pnpm -r typecheck
```

Expected: every command exits 0. Because workspace packages import built `dist`, do not reorder or skip the build.

- [ ] **Step 4: Apply package-scoped version and changelog updates**

Invoke the repository's `version-and-changelog` skill after the full green run. It must inspect the actual code diff and update only changed published packages under `packages/`. Expected affected packages are `@lite-agent/core` and `@lite-agent/sdk`; with the repository's 0.x convention and the new public SDK API/behavior, the expected next version is `0.13.0` for both unless the skill's live diff establishes a different semver result.

The English changelogs must cover:

```markdown
### Minor Changes

- Move explicitly backgrounded work to session-scoped ownership. `run()` and
  `send()` no longer wait for `Agent({ run_in_background: true })` or background
  Bash work; the originating session is automatically woken when work completes.
- Add `LiteAgent.subscribe()` for continuous user/background event delivery and
  `LiteAgent.close()` for explicit background-task cleanup. Ordinary `Agent`
  calls remain blocking by default, and one-shot `query()` closes temporary work.
```

- [ ] **Step 5: Re-run release verification**

Run:

```bash
pnpm -r build
pnpm -r test
pnpm -r typecheck
pnpm release:changed
```

Expected: build/test/typecheck exit 0; `release:changed` is preview-only and lists only the changed publishable packages. Do not pass `--yes`.

- [ ] **Step 6: Commit docs and release metadata separately**

```bash
git add packages/sdk/README.md packages/sdk/README.zh-CN.md
git commit -m "docs(sdk): document session background lifecycle"

git add packages/core/package.json packages/core/CHANGELOG.md packages/sdk/package.json packages/sdk/CHANGELOG.md
git commit -m "chore: release session-scoped background runner"
```

---

## Final acceptance checklist

- `Agent` without `run_in_background` blocks and returns its result inline.
- Explicit background subagents and Bash return before their work finishes.
- A later user turn is accepted while background work is pending.
- Completion wakes the originating session automatically and is persisted once.
- User and completion jobs never overlap within one session.
- Interactive consumers receive autonomous events through `subscribe()`.
- `close()` and `deleteSession()` cancel the intended scopes without late wake-ups.
- `query()` does not leak its temporary background work.
- Core's existing low-level run-local join behavior remains available and tested.
- Full monorepo build, test, typecheck, and release preview pass.
