# Part B-2 — Turn-Boundary Steering (steer / followUp) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a consumer inject user messages into a running agent at turn boundaries — `steer(msg)` to add input before the next model turn, `followUp(msg)` to continue a run that would otherwise stop — without interrupting an in-flight model stream.

**Architecture:** A `SteerController` (mirroring `AbortController`) holds two queues. It is passed per-run via `RunOptions.steer` and reaches the kernel through `KernelConfig.steer`. The kernel drains the queues at the two existing turn boundaries it already owns: (a) right after `turn_start`, it appends queued `steer` messages to `ctx.messages` before the model call; (b) when a turn produces no tool calls (the would-stop branch), it checks `followUp` — if present, it appends them and `continue`s the loop instead of breaking. An additive `steer` event makes injections observable. No model-stream interruption, no abort plumbing.

**Tech Stack:** TypeScript 6 (ESM), pnpm workspace, vitest. No new dependencies.

---

## Decisions / Dependencies

- **Depends on Part B-1** only for the `events.ts` shape: B-1 refactors `AgentEvent` into `{ agentId?: string } & AgentEventBody`. This plan adds a `steer` variant to `AgentEventBody`. If B-1 has **not** landed, add the variant directly to the `AgentEvent` union instead — the rest of the plan is independent of B-1.
- **D1 — semantics:** turn-boundary injection only (the option the user chose). `steer` = inject before the next turn's model call. `followUp` = if a turn would stop (no tool calls), inject and keep looping. No interruption of an in-flight model stream.
- **D2 — threading:** `RunOptions` is a single type shared by core and sdk (sdk imports it from core), and sdk's `run` already forwards `opts` to `core.run`. So adding `steer?` to core's `RunOptions` threads through to the SDK for free. `SteerController` is exported from core and re-exported by the SDK via its existing `export * from "@lite-agent/core"`.
- **D3 — drained, not snapshotted:** queues are *drained* (taken and cleared) at each boundary, so a message enqueued mid-run lands at the next boundary exactly once.

## File Structure

- `packages/core/src/steer.ts` — `SteerController` (new).
- `packages/core/src/index.ts` — export `SteerController`.
- `packages/core/src/events.ts` — add `{ type: "steer"; messages: Message[] }` to `AgentEventBody`.
- `packages/core/src/createAgent.ts` — `RunOptions` += `steer?`; pass it into `runKernel` per run.
- `packages/core/src/kernel.ts` — `KernelConfig` += `steer?`; drain steer at turn start; drain followUp in the no-tools branch.
- `packages/core/test/steer.test.ts` — `SteerController` unit test + kernel integration tests.
- `packages/sdk/src/query.ts` — thread `steer?` through the query options (small).
- `.changeset/partb2-steering.md` — minor changeset.

> **Build choreography:** core's own tests run against `src`; the sdk `query` change reads core's `dist`, so rebuild core (`pnpm --filter @lite-agent/core build`) before the sdk task. Final gate runs `pnpm -r build` first.

> **Branch:** create `feat/partb2-steering` off `main` (after B-1 has merged); do not commit to `main` directly.

---

### Task 1: `SteerController`

**Files:** `packages/core/src/steer.ts`, `packages/core/src/index.ts`, test `packages/core/test/steer.test.ts`

- [ ] **Step 1: Write the failing test** `packages/core/test/steer.test.ts`:

```ts
import { expect, test } from "vitest";
import { SteerController } from "../src/steer";

test("SteerController normalizes strings to user messages and drains once", () => {
  const s = new SteerController();
  s.steer("a");
  s.steer({ role: "user", content: "b" });
  s.followUp("c");
  expect(s.takeSteers()).toEqual([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ]);
  expect(s.takeSteers()).toEqual([]); // drained
  expect(s.takeFollowUps()).toEqual([{ role: "user", content: "c" }]);
  expect(s.takeFollowUps()).toEqual([]);
});
```

- [ ] **Step 2: Run → FAIL** (`SteerController` not found): `pnpm --filter @lite-agent/core test -- steer`.

- [ ] **Step 3: Implement** `packages/core/src/steer.ts`:

```ts
import type { Message } from "./types";

/** Inject user input into a running agent at turn boundaries (mirrors AbortController). */
export class SteerController {
  private _steers: Message[] = [];
  private _followUps: Message[] = [];

  /** Add input applied before the next model turn. */
  steer(content: string | Message): void {
    this._steers.push(typeof content === "string" ? { role: "user", content } : content);
  }
  /** Add input that continues a run which would otherwise stop. */
  followUp(content: string | Message): void {
    this._followUps.push(typeof content === "string" ? { role: "user", content } : content);
  }
  /** Kernel-internal: take and clear queued steers. */
  takeSteers(): Message[] { const s = this._steers; this._steers = []; return s; }
  /** Kernel-internal: take and clear queued follow-ups. */
  takeFollowUps(): Message[] { const f = this._followUps; this._followUps = []; return f; }
}
```

  Export it from `packages/core/src/index.ts` (add alongside the other value exports): `export { SteerController } from "./steer";`

- [ ] **Step 4: Run → PASS**: `pnpm --filter @lite-agent/core test -- steer`. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/steer.ts packages/core/src/index.ts packages/core/test/steer.test.ts
git commit -m "feat(core): SteerController with steer/followUp queues"
```

---

### Task 2: `steer` event + config threading

**Files:** `packages/core/src/events.ts`, `packages/core/src/createAgent.ts`, `packages/core/src/kernel.ts` (config only)

- [ ] **Step 1: Add the event variant.** In `packages/core/src/events.ts`, add to `AgentEventBody` (the union introduced by B-1; if B-1 not present, add to the `AgentEvent` union directly). Ensure `Message` is imported (it already is in the events imports):

```ts
  | { type: "steer"; messages: Message[] }
```
(Place it next to the other observational variants, e.g. after `compaction`.)

- [ ] **Step 2: Thread the option.** In `packages/core/src/createAgent.ts`:
  - Add `SteerController` to imports: `import type { SteerController } from "./steer";`
  - Extend `RunOptions`: `export type RunOptions = { signal?: AbortSignal; sessionId?: string; steer?: SteerController };`
  - In `run`, pass it per-run into the kernel (the cfg is built once, so spread + override):

```ts
    run(input, opts) {
      const signal = opts?.signal ?? new AbortController().signal;
      const sessionId = opts?.sessionId ?? randomUUID();
      return runKernel({ ...kernelCfg, steer: opts?.steer }, input, signal, sessionId);
    },
```

- [ ] **Step 3: Accept it in KernelConfig.** In `packages/core/src/kernel.ts`, add `import type { SteerController } from "./steer";` and a field to `KernelConfig`:

```ts
  /** Optional turn-boundary steering queues (steer/followUp). */
  steer?: SteerController;
```

- [ ] **Step 4: Verify** typecheck clean (`pnpm --filter @lite-agent/core typecheck`) and the full core suite still green (no behavior change yet): `pnpm --filter @lite-agent/core test`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events.ts packages/core/src/createAgent.ts packages/core/src/kernel.ts
git commit -m "feat(core): steer event + thread SteerController into KernelConfig"
```

---

### Task 3: Kernel drains the queues at turn boundaries

**Files:** `packages/core/src/kernel.ts` (turn loop), test `packages/core/test/steer.test.ts`

- [ ] **Step 1: Write the failing integration tests.** Append to `packages/core/test/steer.test.ts`. Use a provider that records the messages of each model call (so we can assert injection):

```ts
import { runKernel } from "../src/kernel";
import { baseCfg, fakeProvider, drain, textBlock } from "./helpers"; // match the helpers kernel.test.ts uses
import type { ModelRequest } from "../src/strategies";

// A provider that records each call's messages and replays a script.
function recordingProvider(script: Parameters<typeof fakeProvider>[0]) {
  const seen: import("../src/types").Message[][] = [];
  const inner = fakeProvider(script);
  return {
    provider: { id: "rec", stream: (req: ModelRequest, signal: AbortSignal) => { seen.push(req.messages); return inner.stream(req, signal); } },
    seen,
  };
}

test("steer injects a user message before the next model turn", async () => {
  const { provider, seen } = recordingProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "noop", input: {} }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const noop = (await import("../src/tools/define")).defineTool({ name: "noop", description: "n", schema: (await import("zod")).z.object({}), execute: async () => "ok" });
  const steer = new SteerController();
  const gen = runKernel(baseCfg({ provider, tools: [noop], steer }), "hi", new AbortController().signal, "s1");
  // Drive turn 1, then steer before turn 2.
  let injected = false;
  const events = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) break;
    events.push(r.value);
    if (r.value.type === "turn_end" && !injected) { steer.steer("MID-RUN"); injected = true; }
  }
  // turn 2's model call must contain the injected message:
  const lastCallMsgs = seen[seen.length - 1]!;
  expect(lastCallMsgs.some((m) => m.role === "user" && m.content === "MID-RUN")).toBe(true);
  expect(events.some((e) => e.type === "steer")).toBe(true);
});

test("followUp continues a run that would otherwise stop", async () => {
  const { provider } = recordingProvider([
    { text: "first", message: { role: "assistant", content: [textBlock("first")] } },  // no tools → would stop
    { text: "second", message: { role: "assistant", content: [textBlock("second")] } }, // also no tools
  ]);
  const steer = new SteerController();
  steer.followUp("keep going");
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, steer }), "hi", new AbortController().signal, "s1"),
  );
  const turnStarts = events.filter((e) => e.type === "turn_start").length;
  expect(turnStarts).toBe(2);                 // resurrected for a second turn
  expect(result.stopReason).toBe("stop");     // the second turn (no followUp left) stops cleanly
  expect(events.some((e) => e.type === "steer")).toBe(true);
});
```
> Adjust the `helpers` import to however `kernel.test.ts` obtains `baseCfg`/`fakeProvider`/`drain`/`textBlock` (they may be defined inline in `kernel.test.ts` — if so, extract them to a shared `test/helpers.ts` in a tiny first step, or inline the same definitions here). Keep `recordingProvider` minimal and matched to the real `ModelProvider`/`ModelRequest` shape.

- [ ] **Step 2: Run → FAIL** (kernel doesn't consume the queues yet).

- [ ] **Step 3: Implement the steer drain at turn start.** In `packages/core/src/kernel.ts`, immediately AFTER `yield { type: "turn_start", turn };` and BEFORE the `beforeModel` lifecycle call, insert:

```ts
    const steers = cfg.steer?.takeSteers() ?? [];
    if (steers.length) {
      ctx.messages.push(...steers);
      for (const m of steers) await append({ type: "user", message: m });
      yield { type: "steer", messages: steers };
    }
```

- [ ] **Step 4: Implement the followUp drain in the no-tools branch.** Replace the current `if (calls.length === 0) { yield turn_end; stopReason = "stop"; break; }` block with:

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
      yield { type: "turn_end", turn, stopReason: "stop" };
      stopReason = "stop";
      break;
    }
```

- [ ] **Step 5: Run → PASS**: `pnpm --filter @lite-agent/core test -- steer`. Then the FULL core suite: `pnpm --filter @lite-agent/core test` — every pre-existing kernel test must stay green (with no `cfg.steer`, both new branches are inert: `takeSteers()`/`takeFollowUps()` are never called because `cfg.steer` is undefined). Typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/kernel.ts packages/core/test/steer.test.ts
git commit -m "feat(core): drain steer/followUp queues at turn boundaries"
```

---

### Task 4: Expose `steer` through `query`

**Files:** `packages/sdk/src/query.ts`

> `createLiteAgent().run(input, { steer })` already works (shared `RunOptions`, sdk forwards `opts` to `core.run`). This task only wires the `query()` facade. Rebuild core first: `pnpm --filter @lite-agent/core build`.

- [ ] **Step 1:** In `packages/sdk/src/query.ts`, add `steer?: SteerController` to the query options type (import `SteerController` from `@lite-agent/core`), and pass it through in the `agent.run(...)` options object (alongside `signal`/`sessionId`). Locate the existing options type and the `agent.run(prompt, { … })` call; thread the field through both.

- [ ] **Step 2: Write the test** in `packages/sdk/test/query.test.ts`:

```ts
test("query forwards a SteerController; followUp continues the run", async () => {
  // build a query() with a fake provider scripting two tool-less turns, pass steer.followUp(...)
  // assert the run produced two turn_start events (continued past the first stop).
  // (Mirror the existing query.test.ts provider/fixture setup.)
});
```
Fill it in using the file's existing fake-provider fixture; assert two `turn_start` events when a `followUp` is queued.

- [ ] **Step 3: Run** `pnpm --filter @lite-agent/sdk test -- query` → PASS. Typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/query.ts packages/sdk/test/query.test.ts
git commit -m "feat(sdk): thread SteerController through query()"
```

---

### Task 5: Full gate + changeset

**Files:** `.changeset/partb2-steering.md`

- [ ] **Step 1: Full gate** — `pnpm -r build && pnpm -r test && pnpm -r typecheck`. All green; typecheck clean incl. `examples/cli`.

- [ ] **Step 2: Changeset** — `.changeset/partb2-steering.md`:

```markdown
---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
---

Add turn-boundary steering: a `SteerController` (mirroring `AbortController`) with `steer(msg)` to inject input before the next model turn and `followUp(msg)` to continue a run that would otherwise stop. Pass it via `run`/`query` options (`{ steer }`). Injections surface as an additive `steer` event. No interruption of in-flight model streams. Purely additive — runs without a controller are unchanged.
```

- [ ] **Step 3: Commit**

```bash
git add .changeset/partb2-steering.md
git commit -m "chore: changeset for turn-boundary steering"
```

> **Deferred (needs consent):** `pnpm version` / publish. Pin `checkpoint-sqlite` back if it cascade-bumps.

---

## Self-Review

- **Spec coverage:** controller (Task 1), event + threading (Task 2), the two boundary drains (Task 3), query exposure (Task 4), packaging (Task 5).
- **Inert when unused:** with no `cfg.steer`, neither drain runs — every existing test is unaffected (verified as a gate in Task 3 Step 5).
- **Semantics (D1) honored:** injection happens only at the two boundaries the kernel already owns; the in-flight model stream is never interrupted; `followUp` reuses the existing `"stop"` `StopReason` (no type change).
- **Threading (D2):** `RunOptions` is shared core↔sdk and sdk already forwards `opts`, so the SDK `run` path needs no change; only `query` needs explicit wiring (Task 4). `SteerController` rides the existing `export *` re-export.
- **Drain-once (D3):** `takeSteers()`/`takeFollowUps()` clear their queues, so a mid-run enqueue lands exactly once at the next boundary — asserted by the unit test and the integration tests.
- **Open detail to resolve in Task 3 Step 1:** whether `baseCfg`/`fakeProvider`/`drain` are shared helpers or inline in `kernel.test.ts`; extract or duplicate minimally — do not refactor the existing kernel tests.
