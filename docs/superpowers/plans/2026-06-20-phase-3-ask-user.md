# Phase 3 — ask_user / InputHandler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the model-initiated half of the interrupt-resume pair: an `ask_user` tool backed by the `InputHandler` strategy, symmetric to the approval gate.

**Architecture:** The kernel threads `input` (the `InputHandler`) and `call` (the tool's own invocation) into the execute-time `ToolContext` — `input` exactly like `sandbox` is threaded, `call` so `ask_user` can stamp the real tool-call id onto its events. The SDK `ask_user` tool reads `ctx.input`/`ctx.call`, emits `input_request` → awaits `ctx.input.request(q)` → emits `input_resolved`, and returns the rendered answer. `createLiteAgent` registers `ask_user` only when `onAskUser` is set (spec §40). The CLI provides a `cliAsker` `InputHandler` that reads a line from the existing raw-mode stdin.

**Tech Stack:** TypeScript (ESM, strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), vitest, zod. No new deps.

**Design decisions (locked):**
- `ctx.input` and `ctx.call` are **optional** fields (bare `ToolContext` literals exist in tests); the kernel always provides them during real execution. `ask_user` guards `ctx.input`.
- `input` is threaded via `ToolContext` (consistent with `sandbox`, matches spec §295), not closured into the tool.
- The events for `ask_user` are observational (kernel drains the queue after the tool resolves); the `InputHandler` does the blocking I/O — same model as approval.
- `UserAnswer` rendering: `selected` joined by ", "; else `text`; else "(no answer)".
- CLI asker parses option numbers (1-based, comma-separated for `multiSelect`) into `selected`, else treats the line as free `text`.

---

## File Structure

- **Modify** `packages/core/src/strategies.ts` — add `readonly call?: ToolCall;` to `ToolContext`.
- **Modify** `packages/core/src/kernel.ts` — `KernelConfig.input?`, pass `input`+`call` into the execute context.
- **Modify** `packages/core/src/createAgent.ts` — `CreateAgentConfig.input?`, forward to kernel.
- **Modify** `packages/core/test/kernel.test.ts` — test the threading.
- **Create** `packages/sdk/src/tools/askUser.ts` — the `ask_user` tool.
- **Modify** `packages/sdk/src/tools/index.ts` — export `askUserTool`.
- **Modify** `packages/sdk/src/createLiteAgent.ts` — `onAskUser?`, conditional registration, pass `input`.
- **Modify** `packages/sdk/src/query.ts` — `onAskUser?` pass-through.
- **Modify** `packages/sdk/src/index.ts` — export `askUserTool`.
- **Create** `packages/sdk/test/askUser.test.ts` — unit + integration tests.
- **Modify** `src/main.ts` — `cliAsker` + stdin line-reader.

---

## Task 1: Core — thread `input` + `call` into ToolContext

**Files:** Modify `packages/core/src/strategies.ts`, `packages/core/src/kernel.ts`, `packages/core/src/createAgent.ts`; test `packages/core/test/kernel.test.ts`.

- [ ] **Step 1: Write the failing test** — append to `packages/core/test/kernel.test.ts`:

```ts
test("kernel threads input + call into the tool execute context", async () => {
  const asker = { request: vi.fn(async () => ({ text: "blue" })) };
  const ask = defineTool({
    name: "ask", description: "ask", schema: z.object({}),
    execute: async (_i, ctx) => {
      ctx.emit({ type: "input_request", call: ctx.call!, question: { question: "color?" } });
      const ans = await ctx.input!.request({ question: "color?" });
      ctx.emit({ type: "input_resolved", id: ctx.call!.id, answer: ans });
      return ans.text ?? "";
    },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "ask", input: {} }] } },
    { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
  ]);
  const { events } = await drain(
    runKernel(baseCfg({ provider, tools: [ask], input: asker }), "hi", new AbortController().signal, "s1"),
  );
  expect(asker.request).toHaveBeenCalledTimes(1);
  const types = events.map((e) => e.type);
  expect(types).toContain("input_request");
  expect(types).toContain("input_resolved");
  expect(events.find((e) => e.type === "tool_result")).toMatchObject({ result: { id: "t1", content: "blue" } });
});
```

Also add `vi` to the vitest import at the top of the file (`import { expect, test, vi } from "vitest";`).

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm --filter @lite-agent-sdk/core test -- kernel`
Expected: FAIL — `KernelConfig` has no `input`, and `ctx.call`/`ctx.input` are not provided (asker never called / `ctx.call` undefined).

- [ ] **Step 3: Add `call` to `ToolContext`** in `packages/core/src/strategies.ts`. The `ToolContext` interface currently ends with `readonly sandbox?: Sandbox;`. Add one line after it:

```ts
  readonly call?: ToolCall;
```

(`ToolCall` is already imported at the top of `strategies.ts`.)

- [ ] **Step 4: Thread through the kernel** in `packages/core/src/kernel.ts`.

Add `InputHandler` to the strategies import (line 1):

```ts
import type { ModelProvider, ToolCallCodec, Tool, Sandbox, InputHandler } from "./strategies";
```

Add to `KernelConfig` (after `sandbox: Sandbox;`):

```ts
  input?: InputHandler;
```

Change the `tool.execute(...)` call (currently `await tool.execute(parsed, { sessionId, signal, emit, sandbox: cfg.sandbox });`) to:

```ts
          const out = await tool.execute(parsed, { sessionId, signal, emit, sandbox: cfg.sandbox, input: cfg.input, call });
```

- [ ] **Step 5: Forward from `createAgent`** in `packages/core/src/createAgent.ts`.

Add `InputHandler` to the strategies type import (line 1):

```ts
import type { ModelProvider, Tool, ToolCallCodec, Sandbox, InputHandler } from "./strategies";
```

Add to `CreateAgentConfig` (after `sandbox?: Sandbox;`):

```ts
  input?: InputHandler;
```

Add to the `kernelCfg` object (after `sandbox: cfg.sandbox ?? noopSandbox(),`):

```ts
    input: cfg.input,
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @lite-agent-sdk/core test && pnpm --filter @lite-agent-sdk/core typecheck`
Expected: all PASS (39 tests), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/strategies.ts packages/core/src/kernel.ts packages/core/src/createAgent.ts packages/core/test/kernel.test.ts
git commit -m "feat(core): thread InputHandler + call into ToolContext (ask_user plumbing)"
```

---

## Task 2: SDK — `ask_user` tool + `onAskUser` wiring

**Files:** Create `packages/sdk/src/tools/askUser.ts`; modify `packages/sdk/src/tools/index.ts`, `packages/sdk/src/createLiteAgent.ts`, `packages/sdk/src/query.ts`, `packages/sdk/src/index.ts`; test `packages/sdk/test/askUser.test.ts`.

- [ ] **Step 1: Write the failing test** `packages/sdk/test/askUser.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { createLiteAgent } from "../src/createLiteAgent";
import { askUserTool } from "../src/tools";
import { fakeProvider, textBlock } from "@lite-agent-sdk/core";
import type { AgentEvent, InputHandler, ToolContext, ToolCall } from "@lite-agent-sdk/core";

function ctxWith(input: InputHandler | undefined, call: ToolCall, events: AgentEvent[]): ToolContext {
  return { sessionId: "s", signal: new AbortController().signal, emit: (e) => events.push(e), input, call };
}

test("ask_user emits request/resolved and returns the rendered text answer", async () => {
  const events: AgentEvent[] = [];
  const input: InputHandler = { request: vi.fn(async () => ({ text: "Bob" })) };
  const out = await askUserTool().execute(
    { question: "name?" },
    ctxWith(input, { id: "t1", name: "ask_user", input: {} }, events),
  );
  expect(out).toBe("Bob");
  expect(input.request).toHaveBeenCalledWith({ question: "name?" });
  expect(events).toEqual([
    { type: "input_request", call: { id: "t1", name: "ask_user", input: {} }, question: { question: "name?" } },
    { type: "input_resolved", id: "t1", answer: { text: "Bob" } },
  ]);
});

test("ask_user renders a multi-select answer as comma-joined", async () => {
  const events: AgentEvent[] = [];
  const input: InputHandler = { request: async () => ({ selected: ["a", "c"] }) };
  const out = await askUserTool().execute(
    { question: "pick", options: ["a", "b", "c"], multiSelect: true },
    ctxWith(input, { id: "t1", name: "ask_user", input: {} }, events),
  );
  expect(out).toBe("a, c");
});

test("ask_user without an input handler returns an error string", async () => {
  const events: AgentEvent[] = [];
  const out = await askUserTool().execute(
    { question: "x" },
    ctxWith(undefined, { id: "t1", name: "ask_user", input: {} }, events),
  );
  expect(out).toMatch(/unavailable/i);
  expect(events).toEqual([]);
});

async function drain(gen: AsyncGenerator<AgentEvent, unknown>) {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return events;
}

function scripted(toolName: string) {
  return fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: toolName, input: { question: "q?" } }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
}

test("createLiteAgent registers ask_user only when onAskUser is configured", async () => {
  const input: InputHandler = { request: async () => ({ text: "yes" }) };
  const withAsker = createLiteAgent({ model: scripted("ask_user"), workdir: process.cwd(), onAskUser: input });
  const events = await drain(withAsker.run("go"));
  const tr = events.find((e) => e.type === "tool_result");
  expect(tr).toMatchObject({ result: { content: "yes" } });
  expect(tr).not.toMatchObject({ result: { isError: true } });

  const withoutAsker = createLiteAgent({ model: scripted("ask_user"), workdir: process.cwd() });
  const events2 = await drain(withoutAsker.run("go"));
  const tr2 = events2.find((e) => e.type === "tool_result");
  expect(tr2).toMatchObject({ result: { isError: true } }); // unknown tool 'ask_user'
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm --filter lite-agent-sdk test -- askUser`
Expected: FAIL — `askUserTool` does not exist / `onAskUser` not accepted.

- [ ] **Step 3: Create the tool** `packages/sdk/src/tools/askUser.ts`:

```ts
import { z } from "zod";
import { defineTool } from "@lite-agent-sdk/core";
import type { Tool, UserAnswer, UserQuestion } from "@lite-agent-sdk/core";

function renderAnswer(a: UserAnswer): string {
  if (a.selected && a.selected.length) return a.selected.join(", ");
  if (a.text && a.text.length) return a.text;
  return "(no answer)";
}

export function askUserTool(): Tool {
  return defineTool({
    name: "ask_user",
    description:
      "Ask the human a question and wait for their answer. Use for decisions, missing information, or confirmations. Provide `options` for a multiple-choice question (set `multiSelect` to allow several).",
    schema: z.object({
      question: z.string().min(1),
      options: z.array(z.string()).optional(),
      multiSelect: z.boolean().optional(),
    }),
    execute: async ({ question, options, multiSelect }, ctx) => {
      if (!ctx.input) return "Error: ask_user is unavailable (no input handler configured).";
      const q: UserQuestion = {
        question,
        ...(options ? { options } : {}),
        ...(multiSelect ? { multiSelect } : {}),
      };
      if (ctx.call) ctx.emit({ type: "input_request", call: ctx.call, question: q });
      const answer = await ctx.input.request(q);
      ctx.emit({ type: "input_resolved", id: ctx.call?.id ?? "ask_user", answer });
      return renderAnswer(answer);
    },
  });
}
```

- [ ] **Step 4: Export from tools index** — add to `packages/sdk/src/tools/index.ts` (after the `todoTool` export):

```ts
export { askUserTool } from "./askUser";
```

- [ ] **Step 5: Wire `createLiteAgent`** in `packages/sdk/src/createLiteAgent.ts`.

Add `askUserTool` to the tools import:

```ts
import { defaultTools, askUserTool } from "./tools";
```

Add `InputHandler` to the type import from `@lite-agent-sdk/core`:

```ts
import type { Agent, ApprovalHandler, InputHandler, Middleware, ModelProvider, PermissionPolicy, Sandbox, Tool } from "@lite-agent-sdk/core";
```

Add to `CreateLiteAgentConfig` (after `onApproval?: ApprovalHandler;`):

```ts
  onAskUser?: InputHandler;
```

Register the tool conditionally — immediately after the `if (cfg.tools) tools.push(...cfg.tools);` line and BEFORE the `allowedTools` filter:

```ts
  if (cfg.onAskUser) tools.push(askUserTool());
```

Add to the `createAgent({...})` call (after `sandbox: cfg.sandbox,`):

```ts
    input: cfg.onAskUser,
```

- [ ] **Step 6: Wire `query`** in `packages/sdk/src/query.ts`.

Add `InputHandler` to the type import. Add to `QueryOptions` (after `onApproval?: ApprovalHandler;`):

```ts
  onAskUser?: InputHandler;
```

Add to the `createLiteAgent({...})` call (after `onApproval: opts.onApproval,`):

```ts
    onAskUser: opts.onAskUser,
```

- [ ] **Step 7: Export from SDK index** — add to `packages/sdk/src/index.ts` where the tools are re-exported (the line `export { defaultTools, bashTool, fileTools, todoTool, makeSafePath } from "./tools";`): add `askUserTool` to that list.

- [ ] **Step 8: Build core + run tests + typecheck**

Run: `pnpm --filter @lite-agent-sdk/core build && pnpm --filter lite-agent-sdk test && pnpm --filter lite-agent-sdk typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add packages/sdk/src/tools/askUser.ts packages/sdk/src/tools/index.ts packages/sdk/src/createLiteAgent.ts packages/sdk/src/query.ts packages/sdk/src/index.ts packages/sdk/test/askUser.test.ts
git commit -m "feat(sdk): ask_user tool + onAskUser wiring (registered only when configured)"
```

---

## Task 3: CLI app — `cliAsker` + raw-mode line reader

**File:** modify `src/main.ts` only. No automated test (CLI entry convention); verified by `pnpm typecheck` + reviewer reasoning.

- [ ] **Step 1: Extend the type import.** Change:

```ts
import type { AgentEvent, ApprovalHandler, Message } from "lite-agent-sdk";
```
to:
```ts
import type { AgentEvent, ApprovalHandler, InputHandler, Message, UserAnswer, UserQuestion } from "lite-agent-sdk";
```

- [ ] **Step 2: Add the line-input slot + `cliAsker`.** Below the existing `pendingApproval` / `onApproval` block, add:

```ts
// A line being typed in response to ask_user. onKey accumulates bytes into `buffer`
// (raw mode, so we echo + handle backspace ourselves) and resolves on Enter.
let pendingInput: { buffer: string; resolve: (text: string) => void } | null = null;

function parseAnswer(q: UserQuestion, text: string): UserAnswer {
  const t = text.trim();
  if (q.options && q.options.length) {
    const picked = t
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10) - 1)
      .filter((n) => Number.isInteger(n) && q.options![n] !== undefined)
      .map((n) => q.options![n]!);
    if (picked.length) return q.multiSelect ? { selected: picked } : { selected: [picked[0]!] };
  }
  return { text: t };
}

const onAskUser: InputHandler = {
  request: (q) =>
    new Promise((resolve) => {
      process.stdout.write(`\n\x1b[36m[ask] ${q.question}\x1b[0m\n`);
      if (q.options && q.options.length) {
        q.options.forEach((o, i) => process.stdout.write(`  ${i + 1}. ${o}\n`));
        process.stdout.write(
          `\x1b[90m(number${q.multiSelect ? "s, comma-separated," : ""} or free text)\x1b[0m > `,
        );
      } else {
        process.stdout.write("> ");
      }
      pendingInput = { buffer: "", resolve: (text) => resolve(parseAnswer(q, text)) };
    }),
};
```

- [ ] **Step 3: Pass `onAskUser` into `createLiteAgent`.** Add to the config object (after `onApproval,`):

```ts
  onAskUser,
```

- [ ] **Step 4: Handle the line read in `onKey`.** In `main()`, the `onKey` handler currently checks `pendingApproval` then ESC. Insert a `pendingInput` branch AFTER the `pendingApproval` branch and BEFORE the ESC branch:

```ts
      if (pendingInput) {
        const b = key[0];
        if (b === 0x0d || b === 0x0a) {
          const { resolve, buffer } = pendingInput;
          pendingInput = null;
          process.stdout.write("\n");
          resolve(buffer);
        } else if (b === 0x7f || b === 0x08) {
          if (pendingInput.buffer.length) {
            pendingInput.buffer = pendingInput.buffer.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (b !== 0x1b) {
          const ch = key.toString();
          pendingInput.buffer += ch;
          process.stdout.write(ch);
        }
        return;
      }
```

- [ ] **Step 5: Reset `pendingInput` in `finally`.** The `finally` block already resets `pendingApproval = null;`. Add next to it:

```ts
      pendingInput = null;
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "feat(app): ask_user support — interactive line/option reader in the CLI"
```

---

## Final verification (after all tasks)

```bash
pnpm -r build && pnpm -r test && pnpm -r typecheck && pnpm typecheck
```

Expected: all green (core +1 test = 39, sdk +4 = 22), typecheck clean everywhere, builds emit dist.
