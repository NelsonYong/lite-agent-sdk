# Agent Core SDK — Phase 1: Foundation & Kernel Walking Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a pnpm monorepo with `@lite-agent/core` containing a fully-tested, event-driven agent kernel that runs a tool-using loop against a fake provider with zero network.

**Architecture:** A tiny async-generator kernel drives turns (encode → model → decode → execute tools → loop) over normalized, provider-agnostic types. Pluggability comes from strategy interfaces (`ModelProvider`, `ToolCallCodec`, `Tool`) and an onion middleware pipeline. The public API is `createAgent({...})` returning `run()` (event stream) and `send()` (await final result).

**Tech Stack:** TypeScript (strict, `moduleResolution: bundler`, extensionless relative imports), ESM, Node ≥ 20, zod 4 (tool schemas + `z.toJSONSchema`), vitest (tests), tsup (build), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-06-18-agent-core-sdk-design.md`

---

## Phase roadmap (this plan = Phase 1)

- **Phase 1 — Foundation & Kernel Walking Skeleton** (this doc): monorepo, normalized types, events/errors, tool definition, FakeProvider, nativeCodec, middleware pipeline, kernel loop, `createAgent`. Deliverable: a tested agent loop with tools over a fake provider.
- **Phase 2 — Real providers:** `@lite-agent/provider-anthropic`, `@lite-agent/provider-openai` + a shared provider contract test suite.
- **Phase 3 — Permission + approval + ask_user:** `PermissionPolicy`/`policy()`, `ApprovalHandler`/`cliApprover()`, `InputHandler`/`cliAsker()`, `askUserTool()`, the `permission()` middleware, and the `approval_*` / `input_*` events wired through the kernel.
- **Phase 4 — Compaction + sessions + retry:** `Compactor`/`defaultCompactor()` (micro + auto), `compaction()` middleware, `Store`/`memoryStore()`/`jsonlStore()`, `retry()` middleware, usage aggregation.
- **Phase 5 — Local-model codecs:** `jsonCodec()` + `reactCodec()` + `maxDecodeRetries` decode-failure recovery.
- **Phase 6 — CLI example + demo features as plugins:** interactive CLI, then re-express skills/background/worktree/monitor/subagent as plugins/tools; changesets release setup.

---

## File structure (Phase 1)

```
pnpm-workspace.yaml                       # workspace: packages/*, examples/*
tsconfig.base.json                        # shared strict TS config
packages/core/
  package.json                            # @lite-agent/core
  tsconfig.json                           # extends ../../tsconfig.base.json
  vitest.config.ts
  src/
    types.ts            # normalized types + block helpers/guards
    events.ts           # AgentEvent union, RunResult, AgentError subclasses
    strategies.ts       # ModelProvider, ToolCallCodec, Tool, ToolContext (+ later-phase interfaces declared)
    middleware.ts       # Middleware interface, AgentContext, compose/runLifecycle
    tools/define.ts     # defineTool(), toToolSpec() (zod → JSON schema)
    codecs/native.ts    # nativeCodec()
    testing/fakeProvider.ts  # fakeProvider() for deterministic tests
    kernel.ts           # runKernel(): the async-generator turn loop
    createAgent.ts      # createAgent() factory → Agent { run, send }
    index.ts            # public exports
  test/
    types.test.ts  events.test.ts  define.test.ts  native.test.ts
    fakeProvider.test.ts  middleware.test.ts  kernel.test.ts  createAgent.test.ts
```

Each `src/*` file has one responsibility; tests mirror source files. The existing demo at the repo root is left untouched in Phase 1 (it relocates to `examples/legacy/` in Phase 6).

---

## Task 1: Monorepo scaffold + `@lite-agent/core` package

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/src/index.ts` (temporary stub)
- Create: `packages/core/test/smoke.test.ts`

- [ ] **Step 1: Create the workspace file**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "examples/*"
```

- [ ] **Step 2: Create the shared TS config**

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "declaration": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "ignoreDeprecations": "6.0"
  }
}
```
> `ignoreDeprecations: "6.0"` is required: TypeScript 6 emits TS5101 for the `baseUrl` that tsup's DTS worker synthesizes, which otherwise breaks `pnpm build`. `esModuleInterop` is intentionally omitted — it is inert under (and can conflict with) `verbatimModuleSyntax`.

- [ ] **Step 3: Create the package manifest**

`packages/core/package.json`:
```json
{
  "name": "@lite-agent/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "zod": "^4.3.6" },
  "devDependencies": { "tsup": "^8.3.0", "typescript": "^6.0.2", "vitest": "^2.1.0" }
}
```

- [ ] **Step 4: Create the package TS config and vitest config**

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist" },
  "include": ["src", "test"]
}
```

`packages/core/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 5: Create a temporary index stub and a smoke test**

`packages/core/src/index.ts`:
```ts
export const VERSION = "0.0.0";
```

`packages/core/test/smoke.test.ts`:
```ts
import { expect, test } from "vitest";
import { VERSION } from "../src/index";

test("package loads", () => {
  expect(VERSION).toBe("0.0.0");
});
```

- [ ] **Step 6: Install and run the smoke test**

Run:
```bash
pnpm install
pnpm --filter @lite-agent/core test
```
Expected: vitest reports `1 passed` for `test/smoke.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml tsconfig.base.json packages/core pnpm-lock.yaml
git commit -m "chore(core): scaffold @lite-agent/core monorepo package"
```

---

## Task 2: Normalized types + block helpers

**Files:**
- Create: `packages/core/src/types.ts`
- Test: `packages/core/test/types.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/types.test.ts`:
```ts
import { expect, test } from "vitest";
import { textBlock, toolResultBlock, isToolCallBlock } from "../src/types";

test("textBlock builds a text content block", () => {
  expect(textBlock("hi")).toEqual({ type: "text", text: "hi" });
});

test("toolResultBlock omits isError when false, sets it when true", () => {
  expect(toolResultBlock("t1", "ok")).toEqual({ type: "tool_result", id: "t1", content: "ok" });
  expect(toolResultBlock("t2", "boom", true)).toEqual({
    type: "tool_result", id: "t2", content: "boom", isError: true,
  });
});

test("isToolCallBlock narrows tool_call blocks", () => {
  expect(isToolCallBlock({ type: "tool_call", id: "a", name: "x", input: {} })).toBe(true);
  expect(isToolCallBlock({ type: "text", text: "x" })).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core test types`
Expected: FAIL — cannot find module `../src/types`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/types.ts`:
```ts
export type Role = "system" | "user" | "assistant" | "tool";

export type TextBlock = { type: "text"; text: string };
export type ToolCallBlock = { type: "tool_call"; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: "tool_result"; id: string; content: string; isError?: boolean };
export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export type Message = { role: Role; content: string | ContentBlock[] };
export type AssistantMessage = { role: "assistant"; content: ContentBlock[] };

export type ToolCall = { id: string; name: string; input: unknown };
export type ToolResult = { id: string; name: string; content: string; isError?: boolean };

export type Usage = { inputTokens: number; outputTokens: number };
export type StopReason = "stop" | "tool_use" | "max_tokens";

export type UserQuestion = { question: string; options?: string[]; multiSelect?: boolean };
export type UserAnswer = { text?: string; selected?: string[] };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type ModelRequest = {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens?: number;
  stopSequences?: string[];
};

export type ModelChunk =
  | { type: "text_delta"; text: string }
  | { type: "message_done"; message: AssistantMessage; usage: Usage };

export const textBlock = (text: string): TextBlock => ({ type: "text", text });

export const toolResultBlock = (id: string, content: string, isError = false): ToolResultBlock =>
  isError ? { type: "tool_result", id, content, isError: true } : { type: "tool_result", id, content };

export const isToolCallBlock = (b: ContentBlock): b is ToolCallBlock => b.type === "tool_call";

export const isTextBlock = (b: ContentBlock): b is TextBlock => b.type === "text";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lite-agent/core test types`
Expected: PASS — 3 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/test/types.test.ts
git commit -m "feat(core): normalized message types and block helpers"
```

---

## Task 3: Events union + error classes

**Files:**
- Create: `packages/core/src/events.ts`
- Test: `packages/core/test/events.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/events.test.ts`:
```ts
import { expect, test } from "vitest";
import { AgentError, ProviderError, ToolError, CodecError, MaxTurnsError, AbortError } from "../src/events";

test("ProviderError carries status and is an AgentError", () => {
  const e = new ProviderError("upstream 503", 503);
  expect(e).toBeInstanceOf(AgentError);
  expect(e.name).toBe("ProviderError");
  expect(e.status).toBe(503);
});

test("error subclasses keep their own name", () => {
  expect(new ToolError("x").name).toBe("ToolError");
  expect(new CodecError("x").name).toBe("CodecError");
  expect(new MaxTurnsError("x").name).toBe("MaxTurnsError");
  expect(new AbortError().name).toBe("AbortError");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core test events`
Expected: FAIL — cannot find module `../src/events`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/events.ts`:
```ts
import type {
  AssistantMessage, Message, StopReason, ToolCall, ToolResult, Usage, UserAnswer, UserQuestion,
} from "./types";

export type RunResult = {
  messages: Message[];
  text: string;
  usage: Usage;
  stopReason: "stop" | "aborted" | "max_turns";
};

export class AgentError extends Error {}
export class ProviderError extends AgentError {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}
export class ToolError extends AgentError {
  constructor(message: string) { super(message); this.name = "ToolError"; }
}
export class CodecError extends AgentError {
  constructor(message: string) { super(message); this.name = "CodecError"; }
}
export class MaxTurnsError extends AgentError {
  constructor(message: string) { super(message); this.name = "MaxTurnsError"; }
}
export class AbortError extends AgentError {
  constructor(message = "aborted") { super(message); this.name = "AbortError"; }
}

export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "message"; message: AssistantMessage }
  | { type: "tool_use"; call: ToolCall }
  | { type: "approval_request"; call: ToolCall; reason?: string }
  | { type: "approval_resolved"; id: string; decision: "allow" | "deny"; by: string }
  | { type: "input_request"; call: ToolCall; question: UserQuestion }
  | { type: "input_resolved"; id: string; answer: UserAnswer }
  | { type: "tool_result"; result: ToolResult }
  | { type: "compaction"; kind: "micro" | "auto"; before: number; after: number }
  | { type: "turn_end"; turn: number; stopReason: StopReason }
  | { type: "error"; error: AgentError; fatal: boolean }
  | { type: "done"; reason: "stop" | "aborted" | "max_turns"; result: RunResult };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lite-agent/core test events`
Expected: PASS — 2 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events.ts packages/core/test/events.test.ts
git commit -m "feat(core): AgentEvent union and typed error classes"
```

---

## Task 4: Strategy interfaces + tool definition

**Files:**
- Create: `packages/core/src/strategies.ts`
- Create: `packages/core/src/tools/define.ts`
- Test: `packages/core/test/define.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/define.test.ts`:
```ts
import { expect, test } from "vitest";
import { z } from "zod";
import { defineTool, toToolSpec } from "../src/tools/define";

const echo = defineTool({
  name: "echo",
  description: "Echo a message back",
  schema: z.object({ msg: z.string() }),
  execute: (input) => input.msg,
});

test("defineTool returns the tool unchanged with typed execute", () => {
  expect(echo.name).toBe("echo");
  expect(echo.execute({ msg: "hi" }, {} as never)).toBe("hi");
});

test("a tool with an async execute resolves to its string", async () => {
  const asyncEcho = defineTool({
    name: "aecho",
    description: "async echo",
    schema: z.object({ msg: z.string() }),
    execute: async (input) => input.msg,
  });
  await expect(Promise.resolve(asyncEcho.execute({ msg: "yo" }, {} as never))).resolves.toBe("yo");
});

test("toToolSpec derives a JSON-schema parameters object from zod", () => {
  const spec = toToolSpec(echo);
  expect(spec.name).toBe("echo");
  expect(spec.description).toBe("Echo a message back");
  expect(spec.parameters).toMatchObject({
    type: "object",
    properties: { msg: { type: "string" } },
    required: ["msg"],
  });
});

test("tool schema rejects bad input", () => {
  expect(() => echo.schema.parse({ msg: 123 })).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core test define`
Expected: FAIL — cannot find module `../src/tools/define`.

- [ ] **Step 3: Write the strategy interfaces**

`packages/core/src/strategies.ts`:
```ts
import type { ZodType } from "zod";
import type {
  AssistantMessage, Message, ModelChunk, ModelRequest, ToolCall, ToolResult, ToolSpec,
  Usage, UserAnswer, UserQuestion,
} from "./types";
import type { AgentEvent } from "./events";

export interface ModelProvider {
  readonly id: string;
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelChunk>;
}

export interface ToolCallCodec {
  encode(req: ModelRequest, tools: ToolSpec[]): ModelRequest;
  decode(message: AssistantMessage): { text: string; calls: ToolCall[] };
}

// Slim context handed to Tool.execute. Approval/Input are wired in Phase 3.
export interface ToolContext {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  emit(ev: AgentEvent): void;
  readonly approval?: ApprovalHandler;
  readonly input?: InputHandler;
}

export interface Tool<I = unknown> {
  name: string;
  description: string;
  schema: ZodType<I>;
  execute(input: I, ctx: ToolContext): Promise<string> | string;
}

// --- Strategies implemented in later phases; declared here so types are stable. ---
export type CompactResult = {
  messages: Message[]; kind?: "micro" | "auto"; before?: number; after?: number;
};
export interface Compactor {
  maybeCompact(messages: Message[], usage: Usage): Promise<CompactResult>;
}

export type Decision = "allow" | "deny" | "ask";
export interface PolicyContext { readonly sessionId: string; }
export interface PermissionPolicy {
  check(call: ToolCall, ctx: PolicyContext): Decision | Promise<Decision>;
}

export interface ApprovalHandler { request(call: ToolCall): Promise<"allow" | "deny">; }
export interface InputHandler { request(q: UserQuestion): Promise<UserAnswer>; }

export interface Store {
  load(id: string): Promise<Message[] | null>;
  save(id: string, messages: Message[]): Promise<void>;
}
```

- [ ] **Step 4: Write the tool-definition helpers**

`packages/core/src/tools/define.ts`:
```ts
import { z } from "zod";
import type { Tool } from "../strategies";
import type { ToolSpec } from "../types";

export function defineTool<I>(def: Tool<I>): Tool<I> {
  return def;
}

export function toToolSpec(tool: Tool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.schema) as Record<string, unknown>,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @lite-agent/core test define`
Expected: PASS — 3 passed. (If `z.toJSONSchema` is missing, upgrade zod: `pnpm --filter @lite-agent/core add zod@^4.3.6`.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/strategies.ts packages/core/src/tools/define.ts packages/core/test/define.test.ts
git commit -m "feat(core): strategy interfaces and zod-backed tool definition"
```

---

## Task 5: nativeCodec + FakeProvider

**Files:**
- Create: `packages/core/src/codecs/native.ts`
- Create: `packages/core/src/testing/fakeProvider.ts`
- Test: `packages/core/test/native.test.ts`
- Test: `packages/core/test/fakeProvider.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/native.test.ts`:
```ts
import { expect, test } from "vitest";
import { nativeCodec } from "../src/codecs/native";
import { textBlock } from "../src/types";
import type { AssistantMessage, ModelRequest, ToolSpec } from "../src/types";

const codec = nativeCodec();

test("encode attaches tool specs when present, leaves request alone when empty", () => {
  const req: ModelRequest = { model: "m", messages: [] };
  const specs: ToolSpec[] = [{ name: "echo", description: "d", parameters: { type: "object" } }];
  expect(codec.encode(req, specs).tools).toEqual(specs);
  expect(codec.encode(req, []).tools).toBeUndefined();
});

test("decode splits text from tool_call blocks", () => {
  const msg: AssistantMessage = {
    role: "assistant",
    content: [textBlock("thinking "), { type: "tool_call", id: "t1", name: "echo", input: { msg: "yo" } }],
  };
  const { text, calls } = codec.decode(msg);
  expect(text).toBe("thinking ");
  expect(calls).toEqual([{ id: "t1", name: "echo", input: { msg: "yo" } }]);
});
```

`packages/core/test/fakeProvider.test.ts`:
```ts
import { expect, test } from "vitest";
import { fakeProvider } from "../src/testing/fakeProvider";
import { textBlock } from "../src/types";
import type { ModelChunk } from "../src/types";

test("fakeProvider streams text deltas then a message_done", async () => {
  const provider = fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]);
  const chunks: ModelChunk[] = [];
  for await (const c of provider.stream({ model: "fake", messages: [] })) chunks.push(c);
  expect(chunks.map((c) => c.type)).toEqual(["text_delta", "text_delta", "message_done"]);
});

test("fakeProvider advances turn by turn, repeating the last", async () => {
  const provider = fakeProvider([
    { message: { role: "assistant", content: [textBlock("one")] } },
    { message: { role: "assistant", content: [textBlock("two")] } },
  ]);
  const first = await collectDone(provider);
  const second = await collectDone(provider);
  const third = await collectDone(provider);
  expect([first, second, third]).toEqual(["one", "two", "two"]);
});

async function collectDone(provider: ReturnType<typeof fakeProvider>): Promise<string> {
  let text = "";
  for await (const c of provider.stream({ model: "fake", messages: [] })) {
    if (c.type === "message_done" && c.message.content[0]?.type === "text") text = c.message.content[0].text;
  }
  return text;
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lite-agent/core test native fakeProvider`
Expected: FAIL — cannot find modules `../src/codecs/native`, `../src/testing/fakeProvider`.

- [ ] **Step 3: Implement nativeCodec**

`packages/core/src/codecs/native.ts`:
```ts
import type { ToolCallCodec } from "../strategies";
import type { AssistantMessage, ModelRequest, ToolCall, ToolSpec } from "../types";
import { isToolCallBlock } from "../types";

export function nativeCodec(): ToolCallCodec {
  return {
    encode(req: ModelRequest, tools: ToolSpec[]): ModelRequest {
      return tools.length ? { ...req, tools } : req;
    },
    decode(message: AssistantMessage) {
      const calls: ToolCall[] = [];
      let text = "";
      for (const block of message.content) {
        if (block.type === "text") text += block.text;
        else if (isToolCallBlock(block)) calls.push({ id: block.id, name: block.name, input: block.input });
      }
      return { text, calls };
    },
  };
}
```

- [ ] **Step 4: Implement FakeProvider**

`packages/core/src/testing/fakeProvider.ts`:
```ts
import type { ModelProvider } from "../strategies";
import type { AssistantMessage, ModelChunk, Usage } from "../types";

export type FakeTurn = { text?: string; message: AssistantMessage; usage?: Usage };

export function fakeProvider(turns: FakeTurn[]): ModelProvider {
  let i = 0;
  return {
    id: "fake",
    async *stream(): AsyncIterable<ModelChunk> {
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      if (!turn) throw new Error("fakeProvider: no turns configured");
      if (turn.text) for (const ch of turn.text) yield { type: "text_delta", text: ch };
      yield {
        type: "message_done",
        message: turn.message,
        usage: turn.usage ?? { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @lite-agent/core test native fakeProvider`
Expected: PASS — 4 passed total.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/codecs/native.ts packages/core/src/testing/fakeProvider.ts packages/core/test/native.test.ts packages/core/test/fakeProvider.test.ts
git commit -m "feat(core): native tool-call codec and fake provider for tests"
```

---

## Task 6: Middleware pipeline (compose + lifecycle)

**Files:**
- Create: `packages/core/src/middleware.ts`
- Test: `packages/core/test/middleware.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/middleware.test.ts`:
```ts
import { expect, test } from "vitest";
import { composeModelCall, composeToolCall, runLifecycle } from "../src/middleware";
import type { AgentContext, Middleware, ToolCallContext } from "../src/middleware";
import type { ModelChunk, ToolResult } from "../src/types";

function baseCtx(): AgentContext {
  return {
    sessionId: "s1", messages: [], turn: 1,
    signal: new AbortController().signal, emit: () => {}, state: new Map(),
  };
}

test("wrapToolCall composes outer→inner in array order", async () => {
  const order: string[] = [];
  const mk = (name: string): Middleware => ({
    name,
    async wrapToolCall(_ctx, next) { order.push(`>${name}`); const r = await next(); order.push(`<${name}`); return r; },
  });
  const ctx = { ...baseCtx(), call: { id: "t1", name: "x", input: {} } } as ToolCallContext;
  const base = async (): Promise<ToolResult> => { order.push("exec"); return { id: "t1", name: "x", content: "ok" }; };
  const exec = composeToolCall([mk("A"), mk("B")], ctx, base);
  const result = await exec();
  expect(result.content).toBe("ok");
  expect(order).toEqual([">A", ">B", "exec", "<B", "<A"]);
});

test("a wrapToolCall middleware can short-circuit without calling next", async () => {
  const block: Middleware = {
    name: "block",
    async wrapToolCall(_ctx) { return { id: "t1", name: "x", content: "denied", isError: true }; },
  };
  const ctx = { ...baseCtx(), call: { id: "t1", name: "x", input: {} } } as ToolCallContext;
  let ran = false;
  const base = async (): Promise<ToolResult> => { ran = true; return { id: "t1", name: "x", content: "ok" }; };
  const result = await composeToolCall([block], ctx, base)();
  expect(ran).toBe(false);
  expect(result).toEqual({ id: "t1", name: "x", content: "denied", isError: true });
});

test("wrapModelCall composes around the base stream", async () => {
  const tag: Middleware = {
    name: "tag",
    async *wrapModelCall(_ctx, next) {
      yield { type: "text_delta", text: "[" };
      for await (const c of next()) yield c;
      yield { type: "text_delta", text: "]" };
    },
  };
  const base = async function* (): AsyncIterable<ModelChunk> { yield { type: "text_delta", text: "x" }; };
  const out: string[] = [];
  for await (const c of composeModelCall([tag], baseCtx(), base)()) {
    if (c.type === "text_delta") out.push(c.text);
  }
  expect(out).toEqual(["[", "x", "]"]);
});

test("runLifecycle invokes a hook on every middleware in order", async () => {
  const seen: string[] = [];
  const mk = (n: string): Middleware => ({ name: n, beforeModel: () => { seen.push(n); } });
  await runLifecycle([mk("A"), mk("B")], "beforeModel", baseCtx());
  expect(seen).toEqual(["A", "B"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core test middleware`
Expected: FAIL — cannot find module `../src/middleware`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/middleware.ts`:
```ts
import type { Message, ModelChunk, ToolCall, ToolResult } from "./types";
import type { AgentEvent } from "./events";

export interface AgentContext {
  readonly sessionId: string;
  messages: Message[];
  readonly turn: number;
  readonly signal: AbortSignal;
  emit(ev: AgentEvent): void;
  state: Map<string, unknown>;
}
export interface ToolCallContext extends AgentContext { readonly call: ToolCall; }

export type ModelCall = () => AsyncIterable<ModelChunk>;
export type ToolExec = () => Promise<ToolResult>;
export type LifecycleHook = "beforeAgent" | "afterAgent" | "beforeModel";

export interface Middleware {
  name: string;
  beforeAgent?(ctx: AgentContext): void | Promise<void>;
  afterAgent?(ctx: AgentContext): void | Promise<void>;
  beforeModel?(ctx: AgentContext): void | Promise<void>;
  wrapModelCall?(ctx: AgentContext, next: ModelCall): AsyncIterable<ModelChunk>;
  wrapToolCall?(ctx: ToolCallContext, next: ToolExec): Promise<ToolResult>;
}

export function composeModelCall(mws: Middleware[], ctx: AgentContext, base: ModelCall): ModelCall {
  return mws
    .filter((m) => m.wrapModelCall)
    .reduceRight<ModelCall>((next, m) => () => m.wrapModelCall!(ctx, next), base);
}

export function composeToolCall(mws: Middleware[], ctx: ToolCallContext, base: ToolExec): ToolExec {
  return mws
    .filter((m) => m.wrapToolCall)
    .reduceRight<ToolExec>((next, m) => () => m.wrapToolCall!(ctx, next), base);
}

export async function runLifecycle(mws: Middleware[], hook: LifecycleHook, ctx: AgentContext): Promise<void> {
  for (const m of mws) {
    const fn = m[hook];
    if (fn) await fn.call(m, ctx);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lite-agent/core test middleware`
Expected: PASS — 4 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/middleware.ts packages/core/test/middleware.test.ts
git commit -m "feat(core): onion middleware pipeline and lifecycle runner"
```

---

## Task 7: Kernel turn loop

**Files:**
- Create: `packages/core/src/kernel.ts`
- Test: `packages/core/test/kernel.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/kernel.test.ts`:
```ts
import { expect, test } from "vitest";
import { z } from "zod";
import { runKernel } from "../src/kernel";
import type { KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { fakeProvider } from "../src/testing/fakeProvider";
import { defineTool } from "../src/tools/define";
import { textBlock } from "../src/types";
import type { AgentEvent, RunResult } from "../src/events";

function baseCfg(over: Partial<KernelConfig>): KernelConfig {
  return { provider: fakeProvider([]), codec: nativeCodec(), tools: [], middleware: [], model: "fake", maxTurns: 10, ...over };
}

async function drain(gen: AsyncGenerator<AgentEvent, RunResult>) {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return { events, result: r.value };
}

test("text-only response yields a clean stop sequence", async () => {
  const provider = fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider }), "hello", new AbortController().signal, "s1"),
  );
  expect(events.map((e) => e.type)).toEqual([
    "turn_start", "text_delta", "text_delta", "message", "turn_end", "done",
  ]);
  expect(result.text).toBe("hi");
  expect(result.stopReason).toBe("stop");
});

test("a tool call is executed and fed back, then the model stops", async () => {
  const echo = defineTool({
    name: "echo", description: "echo", schema: z.object({ msg: z.string() }),
    execute: (i) => i.msg,
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "echo", input: { msg: "yo" } }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { events } = await drain(
    runKernel(baseCfg({ provider, tools: [echo] }), "hi", new AbortController().signal, "s1"),
  );
  expect(events.map((e) => e.type)).toEqual([
    "turn_start", "message", "tool_use", "tool_result", "turn_end",
    "turn_start", "text_delta", "text_delta", "text_delta", "text_delta", "message", "turn_end", "done",
  ]);
  const toolResult = events.find((e) => e.type === "tool_result");
  expect(toolResult).toMatchObject({ type: "tool_result", result: { name: "echo", content: "yo" } });
});

test("an unknown tool returns an error result instead of throwing", async () => {
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "missing", input: {} }] } },
    { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
  ]);
  const { events } = await drain(
    runKernel(baseCfg({ provider }), "hi", new AbortController().signal, "s1"),
  );
  const tr = events.find((e) => e.type === "tool_result");
  expect(tr).toMatchObject({ result: { isError: true } });
});

test("an aborted signal ends the run with reason 'aborted'", async () => {
  const ac = new AbortController();
  ac.abort();
  const provider = fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]);
  const { events, result } = await drain(runKernel(baseCfg({ provider }), "hi", ac.signal, "s1"));
  expect(result.stopReason).toBe("aborted");
  expect(events.at(-1)).toMatchObject({ type: "done", reason: "aborted" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core test kernel`
Expected: FAIL — cannot find module `../src/kernel`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/kernel.ts`:
```ts
import type { ModelProvider, ToolCallCodec, Tool } from "./strategies";
import type { AssistantMessage, Message, ToolResultBlock, Usage } from "./types";
import { textBlock, toolResultBlock } from "./types";
import type { AgentEvent, RunResult } from "./events";
import { ProviderError } from "./events";
import {
  composeModelCall, composeToolCall, runLifecycle,
} from "./middleware";
import type { AgentContext, Middleware, ToolCallContext } from "./middleware";
import { toToolSpec } from "./tools/define";

export interface KernelConfig {
  provider: ModelProvider;
  codec: ToolCallCodec;
  tools: Tool[];
  middleware: Middleware[];
  model: string;
  system?: string;
  maxTurns: number;
  maxTokens?: number;
}

export async function* runKernel(
  cfg: KernelConfig,
  input: string | Message[],
  signal: AbortSignal,
  sessionId: string,
): AsyncGenerator<AgentEvent, RunResult> {
  const messages: Message[] = typeof input === "string" ? [{ role: "user", content: input }] : [...input];
  const queue: AgentEvent[] = [];
  const emit = (ev: AgentEvent) => { queue.push(ev); };
  const toolMap = new Map(cfg.tools.map((t) => [t.name, t]));
  const toolSpecs = cfg.tools.map(toToolSpec);
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };

  function* drain(): Generator<AgentEvent> {
    while (queue.length) yield queue.shift()!;
  }
  const mkCtx = (turn: number): AgentContext => ({ sessionId, messages, turn, signal, emit, state });
  const state = new Map<string, unknown>();

  await runLifecycle(cfg.middleware, "beforeAgent", mkCtx(0));
  yield* drain();

  let stopReason: RunResult["stopReason"] = "max_turns";

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    // Phase 1: abort is observed only at turn boundaries.
    if (signal.aborted) { stopReason = "aborted"; break; }
    const ctx = mkCtx(turn);
    yield { type: "turn_start", turn };

    await runLifecycle(cfg.middleware, "beforeModel", ctx);
    yield* drain();

    const req = cfg.codec.encode(
      { model: cfg.model, system: cfg.system, messages: ctx.messages, maxTokens: cfg.maxTokens },
      toolSpecs,
    );
    const modelCall = composeModelCall(cfg.middleware, ctx, () => cfg.provider.stream(req, signal));

    let assistant: AssistantMessage | undefined;
    for await (const chunk of modelCall()) {
      if (chunk.type === "text_delta") yield { type: "text_delta", text: chunk.text };
      else {
        assistant = chunk.message;
        usage = {
          inputTokens: usage.inputTokens + chunk.usage.inputTokens,
          outputTokens: usage.outputTokens + chunk.usage.outputTokens,
        };
      }
    }
    yield* drain();
    if (!assistant) throw new ProviderError("provider produced no message_done chunk");

    ctx.messages.push(assistant);
    yield { type: "message", message: assistant };

    const { calls } = cfg.codec.decode(assistant);
    if (calls.length === 0) {
      yield { type: "turn_end", turn, stopReason: "stop" };
      stopReason = "stop";
      break;
    }

    const resultBlocks: ToolResultBlock[] = [];
    for (const call of calls) {
      yield { type: "tool_use", call };
      const tctx: ToolCallContext = { ...ctx, call };
      const tool = toolMap.get(call.name);
      const baseExec = async () => {
        if (!tool) return { id: call.id, name: call.name, content: `Error: unknown tool '${call.name}'`, isError: true };
        try {
          const parsed = tool.schema.parse(call.input);
          const out = await tool.execute(parsed, { sessionId, signal, emit });
          return { id: call.id, name: call.name, content: String(out) };
        } catch (e) {
          return { id: call.id, name: call.name, content: `Error: ${(e as Error).message}`, isError: true };
        }
      };
      const result = await composeToolCall(cfg.middleware, tctx, baseExec)();
      yield* drain();
      resultBlocks.push(toolResultBlock(result.id, result.content, result.isError));
      yield { type: "tool_result", result };
    }
    ctx.messages.push({ role: "user", content: resultBlocks });
    yield { type: "turn_end", turn, stopReason: "tool_use" };
  }

  await runLifecycle(cfg.middleware, "afterAgent", mkCtx(0));
  yield* drain();

  const result: RunResult = { messages, text: lastAssistantText(messages), usage, stopReason };
  yield { type: "done", reason: stopReason, result };
  return result;
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && Array.isArray(m.content)) {
      return m.content.filter(isTextBlock).map((b) => b.text).join("");
    }
  }
  return "";
}
```

> Note: `textBlock` is imported for type-parity with other modules but `lastAssistantText` reads existing blocks; if the linter flags it as unused, drop it from the import. Keep `toolResultBlock`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lite-agent/core test kernel`
Expected: PASS — 4 passed.

- [ ] **Step 5: Fix the unused import if typecheck complains**

Run: `pnpm --filter @lite-agent/core typecheck`
Expected: no errors. If it reports `textBlock` is declared but never used, edit `kernel.ts` line 1's type import to `import { isTextBlock, toolResultBlock } from "./types";` and re-run.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/kernel.ts packages/core/test/kernel.test.ts
git commit -m "feat(core): event-driven kernel turn loop"
```

---

## Task 8: `createAgent` factory + public API

**Files:**
- Create: `packages/core/src/createAgent.ts`
- Modify: `packages/core/src/index.ts` (replace the stub)
- Modify: `packages/core/test/smoke.test.ts` (replace VERSION smoke with a real API smoke)
- Test: `packages/core/test/createAgent.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/createAgent.test.ts`:
```ts
import { expect, test } from "vitest";
import { z } from "zod";
import { createAgent } from "../src/createAgent";
import { nativeCodec } from "../src/codecs/native";
import { fakeProvider } from "../src/testing/fakeProvider";
import { defineTool } from "../src/tools/define";
import { textBlock } from "../src/types";

test("send() runs the loop and returns the final result", async () => {
  const agent = createAgent({
    model: fakeProvider([{ text: "hello world", message: { role: "assistant", content: [textBlock("hello world")] } }]),
    codec: nativeCodec(),
  });
  const result = await agent.send("hi");
  expect(result.text).toBe("hello world");
  expect(result.stopReason).toBe("stop");
});

test("run() streams events for a tool-using turn via configured tools", async () => {
  const add = defineTool({
    name: "add", description: "add two numbers",
    schema: z.object({ a: z.number(), b: z.number() }),
    execute: (i) => String(i.a + i.b),
  });
  const agent = createAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "add", input: { a: 2, b: 3 } }] } },
      { text: "5", message: { role: "assistant", content: [textBlock("5")] } },
    ]),
    codec: nativeCodec(),
    tools: [add],
  });
  const types: string[] = [];
  for await (const ev of agent.run("2+3?")) types.push(ev.type);
  expect(types).toContain("tool_use");
  expect(types).toContain("tool_result");
  expect(types.at(-1)).toBe("done");
});

test("a user middleware observes via beforeAgent", async () => {
  const seen: string[] = [];
  const agent = createAgent({
    model: fakeProvider([{ text: "x", message: { role: "assistant", content: [textBlock("x")] } }]),
    codec: nativeCodec(),
    use: [{ name: "spy", beforeAgent: () => { seen.push("before"); } }],
  });
  await agent.send("hi");
  expect(seen).toEqual(["before"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core test createAgent`
Expected: FAIL — cannot find module `../src/createAgent`.

- [ ] **Step 3: Implement `createAgent`**

`packages/core/src/createAgent.ts`:
```ts
import type { ModelProvider, Tool, ToolCallCodec } from "./strategies";
import type { Middleware } from "./middleware";
import type { Message } from "./types";
import type { AgentEvent, RunResult } from "./events";
import { runKernel } from "./kernel";
import type { KernelConfig } from "./kernel";

export interface CreateAgentConfig {
  model: ModelProvider;
  modelName?: string;
  codec: ToolCallCodec;
  tools?: Tool[];
  use?: Middleware[];
  system?: string;
  maxTurns?: number;
  maxTokens?: number;
}

export type RunOptions = { signal?: AbortSignal; sessionId?: string };

export interface Agent {
  run(input: string | Message[], opts?: RunOptions): AsyncGenerator<AgentEvent, RunResult>;
  send(input: string | Message[], opts?: RunOptions): Promise<RunResult>;
}

let sessionCounter = 0;

export function createAgent(cfg: CreateAgentConfig): Agent {
  const kernelCfg: KernelConfig = {
    provider: cfg.model,
    codec: cfg.codec,
    tools: cfg.tools ?? [],
    middleware: cfg.use ?? [],
    model: cfg.modelName ?? cfg.model.id,
    system: cfg.system,
    maxTurns: cfg.maxTurns ?? 50,
    maxTokens: cfg.maxTokens,
  };

  const agent: Agent = {
    run(input, opts) {
      const signal = opts?.signal ?? new AbortController().signal;
      const sessionId = opts?.sessionId ?? `s${++sessionCounter}`;
      return runKernel(kernelCfg, input, signal, sessionId);
    },
    async send(input, opts) {
      const gen = agent.run(input, opts);
      let r = await gen.next();
      while (!r.done) r = await gen.next();
      return r.value;
    },
  };
  return agent;
}
```

- [ ] **Step 4: Replace the index with real public exports**

`packages/core/src/index.ts`:
```ts
export { createAgent } from "./createAgent";
export type { Agent, CreateAgentConfig, RunOptions } from "./createAgent";

export { nativeCodec } from "./codecs/native";
export { defineTool, toToolSpec } from "./tools/define";
export { fakeProvider } from "./testing/fakeProvider";
export type { FakeTurn } from "./testing/fakeProvider";

export { composeModelCall, composeToolCall, runLifecycle } from "./middleware";
export type { AgentContext, ToolCallContext, Middleware, ModelCall, ToolExec } from "./middleware";

export type {
  ModelProvider, ToolCallCodec, Tool, ToolContext,
  Compactor, CompactResult, PermissionPolicy, PolicyContext, Decision,
  ApprovalHandler, InputHandler, Store,
} from "./strategies";

export type { AgentEvent, RunResult } from "./events";
export {
  AgentError, ProviderError, ToolError, CodecError, MaxTurnsError, AbortError,
} from "./events";

export * from "./types";
```

- [ ] **Step 5: Replace the smoke test to exercise the public entry point**

`packages/core/test/smoke.test.ts`:
```ts
import { expect, test } from "vitest";
import { createAgent, nativeCodec, fakeProvider, textBlock } from "../src/index";

test("public API: createAgent + nativeCodec + fakeProvider run end to end", async () => {
  const agent = createAgent({
    model: fakeProvider([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]),
    codec: nativeCodec(),
  });
  const result = await agent.send("hi");
  expect(result.text).toBe("ok");
});
```

- [ ] **Step 6: Run the full test suite + typecheck + build**

Run:
```bash
pnpm --filter @lite-agent/core test
pnpm --filter @lite-agent/core typecheck
pnpm --filter @lite-agent/core build
```
Expected: all tests pass (8 files), typecheck clean, `dist/index.js` + `dist/index.d.ts` produced.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/createAgent.ts packages/core/src/index.ts packages/core/test/createAgent.test.ts packages/core/test/smoke.test.ts
git commit -m "feat(core): createAgent factory and public API surface"
```

---

## Definition of done (Phase 1)

- `pnpm --filter @lite-agent/core test` is green across all 8 test files.
- `pnpm --filter @lite-agent/core typecheck` and `build` succeed.
- A consumer can write `createAgent({ model, codec: nativeCodec(), tools })` and drive a tool-using loop over the event stream, entirely offline via `fakeProvider`.
- No `ModelProvider` for a real LLM yet (Phase 2), no permission/approval (Phase 3), no compaction/sessions (Phase 4) — those are deliberately out of Phase 1 scope.

---

## Self-review

**Spec coverage (Phase 1 portion):** normalized types ✅ (T2), event union incl. approval/input/compaction variants ✅ (T3, emitted in later phases), strategy interfaces incl. `InputHandler` ✅ (T4), `Tool` + zod schema + `z.toJSONSchema` ✅ (T4), `nativeCodec` ✅ (T5), `FakeProvider` + golden event-stream tests ✅ (T5, T7), middleware pipeline + "strategy vs middleware vs event" boundaries embodied by the interfaces ✅ (T6), event-driven kernel with abort handling ✅ (T7), `createAgent` `run()`/`send()` ✅ (T8), monorepo + Node≥20 + ESM + zod + vitest + tsup ✅ (T1). Deferred-by-design and tracked in the roadmap: real providers (P2), permission/approval/ask_user (P3), compaction/sessions/retry (P4), json/react codecs (P5), CLI + demo-plugins (P6).

**Placeholder scan:** No "TBD/TODO/handle edge cases" — every code step has full code, every run step has an exact command + expected outcome. The one conditional instruction (T7 Step 5, drop unused import) is a concrete, testable remediation, not a placeholder.

**Type consistency check:** `KernelConfig` fields (`provider/codec/tools/middleware/model/system/maxTurns/maxTokens`) match what `createAgent` constructs (T8) and what `runKernel` consumes (T7). `RunResult.stopReason` union (`"stop"|"aborted"|"max_turns"`) is identical in `events.ts` (T3) and used unchanged in the kernel (T7). `ToolContext` (sessionId/signal/emit/approval?/input?) in T4 matches the object passed to `tool.execute` in the kernel (T7 passes `{ sessionId, signal, emit }`, the optional approval/input simply absent in Phase 1). `toToolSpec`/`defineTool` names match across T4, T7, T8. `fakeProvider`/`FakeTurn` names consistent across T5, T7, T8. Middleware method names (`wrapModelCall/wrapToolCall/beforeAgent/afterAgent/beforeModel`) consistent across T6, T7, T8.
