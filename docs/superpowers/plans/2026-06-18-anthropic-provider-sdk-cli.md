# Anthropic Provider + SDK + CLI Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first end-to-end runnable CLI on top of `@lite-agent/core`: a real Anthropic model provider, a batteries-included SDK (default tools + skills) whose API is shaped after `@anthropic-ai/claude-agent-sdk`, and a rewritten `src/` app — with all old demo code removed.

**Architecture:** Three layers. `@lite-agent/provider` wraps the raw `@anthropic-ai/sdk` Messages API into a `ModelProvider`. `lite-agent` adds default tools, skill loading, a `createLiteAgent` factory, and `query()`/`tool()` ergonomics. The outer `src/` CLI wires a provider + the SDK into an event-stream REPL.

**Tech Stack:** TypeScript 6 (strict, ESM, moduleResolution Bundler, verbatimModuleSyntax, noUncheckedIndexedAccess), pnpm workspace, tsup (build), vitest (test), zod 4, `@anthropic-ai/sdk` ^0.80.0.

---

## Reference design

Spec: `docs/superpowers/specs/2026-06-18-anthropic-provider-sdk-cli-design.md`.

## Setup notes (read once before Task 1)

- **Two distinct SDKs:** `@anthropic-ai/sdk` is the raw model client we wrap; `@anthropic-ai/claude-agent-sdk` is only an **API-design reference** (never a dependency).
- **Core must be built** so downstream packages resolve its types/runtime via `dist`: run `pnpm --filter @lite-agent/core build` if `packages/core/dist/index.d.ts` is missing.
- **After creating each new `package.json`**, run `pnpm install` at the repo root to create the workspace symlinks.
- Each package mirrors core's config: `package.json` (tsup build / vitest test / tsc typecheck) + `tsconfig.json` extending `../../tsconfig.base.json` with `{ "outDir": "dist", "types": ["node"] }` and `include: ["src","test"]`.
- Tests live in `<pkg>/test/*.test.ts` (vitest default discovery; no config file needed).
- Commit after every task with a `feat:`/`refactor:` message ending in the `Co-Authored-By` trailer.

---

## Task 1: Scaffold `@lite-agent/provider` + request mapping

**Files:**

- Create: `packages/provider-anthropic/package.json`
- Create: `packages/provider-anthropic/tsconfig.json`
- Create: `packages/provider-anthropic/src/mapping.ts`
- Test: `packages/provider-anthropic/test/mapping.test.ts`

- [ ] **Step 1: Create `packages/provider-anthropic/package.json`**

```json
{
  "name": "@lite-agent/provider",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "engines": { "node": ">=20" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.80.0",
    "@lite-agent/core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^25.5.0",
    "tsup": "^8.3.0",
    "typescript": "^6.0.2",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `packages/provider-anthropic/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "types": ["node"] },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Install workspace links**

Run: `pnpm install`
Expected: adds `@lite-agent/provider`, links `@lite-agent/core`. Exit 0.

- [ ] **Step 4: Write the failing test** — `packages/provider-anthropic/test/mapping.test.ts`

```ts
import { expect, test } from "vitest";
import { toAnthropicParams } from "../src/mapping";
import type { ModelRequest } from "@lite-agent/core";

test("hoists system, maps blocks, builds tools, strips $schema, defaults max_tokens", () => {
  const req: ModelRequest = {
    model: "m1",
    system: "you are x",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_call", id: "c1", name: "add", input: { a: 1 } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", id: "c1", content: "2" }],
      },
    ],
    tools: [
      {
        name: "add",
        description: "add",
        parameters: {
          $schema: "x",
          type: "object",
          properties: { a: { type: "number" } },
          required: ["a"],
        },
      },
    ],
  };
  const p = toAnthropicParams(req);
  expect(p.model).toBe("m1");
  expect(p.system).toBe("you are x");
  expect(p.max_tokens).toBe(4096);
  expect(p.stream).toBe(true);
  expect(p.messages).toEqual([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_use", id: "c1", name: "add", input: { a: 1 } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: "2" }],
    },
  ]);
  expect(p.tools).toEqual([
    {
      name: "add",
      description: "add",
      input_schema: {
        type: "object",
        properties: { a: { type: "number" } },
        required: ["a"],
      },
    },
  ]);
});

test("uses provided maxTokens and omits tools/system when absent", () => {
  const p = toAnthropicParams({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 100,
  });
  expect(p.max_tokens).toBe(100);
  expect(p.tools).toBeUndefined();
  expect(p.system).toBeUndefined();
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/provider test`
Expected: FAIL — `toAnthropicParams` not found.

- [ ] **Step 6: Implement `packages/provider-anthropic/src/mapping.ts`**

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  Message,
  ModelRequest,
  ToolSpec,
} from "@lite-agent/core";

const DEFAULT_MAX_TOKENS = 4096;

function toBlockParam(b: ContentBlock): Anthropic.ContentBlockParam {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_call") {
    return {
      type: "tool_use",
      id: b.id,
      name: b.name,
      input: (b.input ?? {}) as Record<string, unknown>,
    };
  }
  return b.isError
    ? {
        type: "tool_result",
        tool_use_id: b.id,
        content: b.content,
        is_error: true,
      }
    : { type: "tool_result", tool_use_id: b.id, content: b.content };
}

function toMessageParam(m: Message): Anthropic.MessageParam {
  const role: "user" | "assistant" =
    m.role === "assistant" ? "assistant" : "user";
  const content =
    typeof m.content === "string" ? m.content : m.content.map(toBlockParam);
  return { role, content };
}

function toInputSchema(
  parameters: Record<string, unknown>,
): Anthropic.Tool.InputSchema {
  const { $schema: _drop, ...rest } = parameters;
  return rest as Anthropic.Tool.InputSchema;
}

function toTool(spec: ToolSpec): Anthropic.Tool {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: toInputSchema(spec.parameters),
  };
}

export function toAnthropicParams(
  req: ModelRequest,
): Anthropic.MessageCreateParamsStreaming {
  const params: Anthropic.MessageCreateParamsStreaming = {
    model: req.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: req.messages
      .filter((m) => m.role !== "system")
      .map(toMessageParam),
    stream: true,
  };
  if (req.system) params.system = req.system;
  if (req.stopSequences) params.stop_sequences = req.stopSequences;
  if (req.tools && req.tools.length) params.tools = req.tools.map(toTool);
  return params;
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @lite-agent/provider test`
Expected: PASS (2 tests).

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @lite-agent/provider typecheck`
Expected: clean (no errors). If `@lite-agent/core` types fail to resolve, run `pnpm --filter @lite-agent/core build` first.

- [ ] **Step 9: Commit**

```bash
git add packages/provider-anthropic pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(provider-anthropic): scaffold package + request mapping"
```

---

## Task 2: Stream translation

**Files:**

- Create: `packages/provider-anthropic/src/stream.ts`
- Test: `packages/provider-anthropic/test/stream.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/provider-anthropic/test/stream.test.ts`

```ts
import { expect, test } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelChunk } from "@lite-agent/core";
import { translateStream } from "../src/stream";

async function* gen(events: Anthropic.RawMessageStreamEvent[]) {
  for (const e of events) yield e;
}

test("translates text + tool_use stream into ModelChunks", async () => {
  const events = [
    {
      type: "message_start",
      message: { usage: { input_tokens: 10, output_tokens: 0 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " world" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "t1", name: "add", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"a":1,' },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"b":2}' },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 7 },
    },
    { type: "message_stop" },
  ] as unknown as Anthropic.RawMessageStreamEvent[];

  const chunks: ModelChunk[] = [];
  for await (const c of translateStream(gen(events))) chunks.push(c);

  const deltas = chunks.filter((c) => c.type === "text_delta");
  expect(
    deltas.map((d) => (d.type === "text_delta" ? d.text : "")).join(""),
  ).toBe("Hello world");

  const done = chunks.at(-1);
  expect(done?.type).toBe("message_done");
  if (done?.type === "message_done") {
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 7 });
    expect(done.message.content).toEqual([
      { type: "text", text: "Hello world" },
      { type: "tool_call", id: "t1", name: "add", input: { a: 1, b: 2 } },
    ]);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/provider test stream`
Expected: FAIL — `translateStream` not found.

- [ ] **Step 3: Implement `packages/provider-anthropic/src/stream.ts`**

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantMessage,
  ContentBlock,
  ModelChunk,
  Usage,
} from "@lite-agent/core";

export async function* translateStream(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent>,
): AsyncGenerator<ModelChunk> {
  const blocks: (ContentBlock | undefined)[] = [];
  const toolJson: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of events) {
    switch (event.type) {
      case "message_start":
        inputTokens = event.message.usage.input_tokens;
        break;
      case "content_block_start": {
        const cb = event.content_block;
        if (cb.type === "text") {
          blocks[event.index] = { type: "text", text: cb.text };
        } else if (cb.type === "tool_use") {
          blocks[event.index] = {
            type: "tool_call",
            id: cb.id,
            name: cb.name,
            input: {},
          };
          toolJson[event.index] = "";
        }
        break;
      }
      case "content_block_delta": {
        const d = event.delta;
        if (d.type === "text_delta") {
          const b = blocks[event.index];
          if (b && b.type === "text") b.text += d.text;
          yield { type: "text_delta", text: d.text };
        } else if (d.type === "input_json_delta") {
          toolJson[event.index] =
            (toolJson[event.index] ?? "") + d.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        const b = blocks[event.index];
        if (b && b.type === "tool_call") {
          const raw = toolJson[event.index] ?? "";
          b.input = raw ? JSON.parse(raw) : {};
        }
        break;
      }
      case "message_delta":
        outputTokens = event.usage.output_tokens;
        break;
      case "message_stop": {
        const message: AssistantMessage = {
          role: "assistant",
          content: blocks.filter((b): b is ContentBlock => b !== undefined),
        };
        const usage: Usage = { inputTokens, outputTokens };
        yield { type: "message_done", message, usage };
        break;
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lite-agent/provider test stream`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @lite-agent/provider typecheck`
Expected: clean.

```bash
git add packages/provider-anthropic
git commit -m "feat(provider-anthropic): translate Anthropic stream events to ModelChunks"
```

---

## Task 3: Provider assembly + package exports

**Files:**

- Create: `packages/provider-anthropic/src/anthropic.ts`
- Create: `packages/provider-anthropic/src/index.ts`
- Test: `packages/provider-anthropic/test/anthropic.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/provider-anthropic/test/anthropic.test.ts`

```ts
import { expect, test } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelChunk } from "@lite-agent/core";
import { anthropic } from "../src/index";
import type { AnthropicClientLike } from "../src/index";

test("provider streams ModelChunks via an injected client and forwards params", async () => {
  let captured: Anthropic.MessageCreateParamsStreaming | undefined;
  const fakeClient: AnthropicClientLike = {
    messages: {
      create(params) {
        captured = params;
        async function* gen() {
          yield {
            type: "message_start",
            message: { usage: { input_tokens: 3, output_tokens: 0 } },
          };
          yield {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          };
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hi" },
          };
          yield { type: "content_block_stop", index: 0 };
          yield {
            type: "message_delta",
            delta: {},
            usage: { output_tokens: 1 },
          };
          yield { type: "message_stop" };
        }
        return gen() as unknown as AsyncIterable<Anthropic.RawMessageStreamEvent>;
      },
    },
  };

  const provider = anthropic({ client: fakeClient });
  expect(provider.id).toBe("anthropic");

  const chunks: ModelChunk[] = [];
  for await (const c of provider.stream({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  })) {
    chunks.push(c);
  }

  expect(captured?.model).toBe("m");
  expect(captured?.stream).toBe(true);
  expect(chunks.at(-1)).toMatchObject({
    type: "message_done",
    message: { content: [{ type: "text", text: "hi" }] },
    usage: { inputTokens: 3, outputTokens: 1 },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/provider test anthropic`
Expected: FAIL — `anthropic` / `AnthropicClientLike` not found.

- [ ] **Step 3: Implement `packages/provider-anthropic/src/anthropic.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { ModelChunk, ModelProvider, ModelRequest } from "@lite-agent/core";
import { toAnthropicParams } from "./mapping";
import { translateStream } from "./stream";

// Minimal structural shape we depend on — lets tests inject a fake (no network).
export interface AnthropicClientLike {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ):
      | Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>>
      | AsyncIterable<Anthropic.RawMessageStreamEvent>;
  };
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  client?: AnthropicClientLike;
}

export function anthropic(opts: AnthropicProviderOptions = {}): ModelProvider {
  const client: AnthropicClientLike =
    opts.client ??
    (new Anthropic({
      apiKey: opts.apiKey ?? process.env["ANTHROPIC_API_KEY"],
      baseURL: opts.baseURL ?? process.env["BASE_URL"],
    }) as unknown as AnthropicClientLike);

  return {
    id: "anthropic",
    async *stream(
      req: ModelRequest,
      signal?: AbortSignal,
    ): AsyncIterable<ModelChunk> {
      const params = toAnthropicParams(req);
      const raw = await client.messages.create(
        params,
        signal ? { signal } : undefined,
      );
      yield* translateStream(raw);
    },
  };
}
```

- [ ] **Step 4: Implement `packages/provider-anthropic/src/index.ts`**

```ts
export { anthropic } from "./anthropic";
export type {
  AnthropicProviderOptions,
  AnthropicClientLike,
} from "./anthropic";
export { toAnthropicParams } from "./mapping";
export { translateStream } from "./stream";
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @lite-agent/provider test`
Expected: PASS (all 3 test files).
Run: `pnpm --filter @lite-agent/provider typecheck`
Expected: clean.

- [ ] **Step 6: Build (verify dts emits)**

Run: `pnpm --filter @lite-agent/provider build`
Expected: emits `dist/index.js` + `dist/index.d.ts`. Exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/provider-anthropic
git commit -m "feat(provider-anthropic): assemble ModelProvider + public exports"
```

---

## Task 4: Scaffold `lite-agent` + file tools

**Files:**

- Create: `packages/sdk/package.json`
- Create: `packages/sdk/tsconfig.json`
- Create: `packages/sdk/src/tools/file.ts`
- Test: `packages/sdk/test/file.test.ts`

- [ ] **Step 1: Create `packages/sdk/package.json`**

```json
{
  "name": "lite-agent",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "engines": { "node": ">=20" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@lite-agent/core": "workspace:*", "zod": "^4.3.6" },
  "devDependencies": {
    "@types/node": "^25.5.0",
    "tsup": "^8.3.0",
    "typescript": "^6.0.2",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `packages/sdk/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "types": ["node"] },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Install workspace links**

Run: `pnpm install`
Expected: adds `lite-agent`. Exit 0.

- [ ] **Step 4: Write the failing test** — `packages/sdk/test/file.test.ts`

```ts
import { expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@lite-agent/core";
import { fileTools, makeSafePath } from "../src/tools/file";

const ctx: ToolContext = {
  sessionId: "s",
  signal: new AbortController().signal,
  emit: () => {},
};

test("read/write/edit operate within the workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-"));
  const [read, write, edit] = fileTools(dir);
  expect(
    await write!.execute({ path: "a.txt", content: "hello" }, ctx),
  ).toContain("Wrote");
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello");
  expect(await read!.execute({ path: "a.txt" }, ctx)).toBe("hello");
  await edit!.execute(
    { path: "a.txt", old_text: "hello", new_text: "bye" },
    ctx,
  );
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("bye");
});

test("safePath blocks escaping the workspace", () => {
  const safe = makeSafePath("/tmp/work");
  expect(() => safe("../etc/passwd")).toThrow(/escapes workspace/);
  expect(safe("sub/a.txt")).toBe("/tmp/work/sub/a.txt");
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter lite-agent test file`
Expected: FAIL — `fileTools` not found.

- [ ] **Step 6: Implement `packages/sdk/src/tools/file.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";

const MAX_BYTES = 50_000;

export function makeSafePath(workdir: string): (p: string) => string {
  const root = resolve(workdir);
  return (p: string): string => {
    const full = resolve(root, p);
    if (full !== root && !full.startsWith(root + "/")) {
      throw new Error(`Path escapes workspace: ${p}`);
    }
    return full;
  };
}

export function fileTools(workdir: string): Tool[] {
  const safePath = makeSafePath(workdir);

  const readFile = defineTool({
    name: "read_file",
    description: "Read file contents.",
    schema: z.object({ path: z.string(), limit: z.number().int().optional() }),
    execute: ({ path, limit }) => {
      const lines = readFileSync(safePath(path), "utf8").split("\n");
      if (limit && limit < lines.length) {
        return [
          ...lines.slice(0, limit),
          `... (${lines.length - limit} more lines)`,
        ]
          .join("\n")
          .slice(0, MAX_BYTES);
      }
      return lines.join("\n").slice(0, MAX_BYTES);
    },
  });

  const writeFile = defineTool({
    name: "write_file",
    description: "Write content to a file.",
    schema: z.object({ path: z.string(), content: z.string() }),
    execute: ({ path, content }) => {
      const fp = safePath(path);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content);
      return `Wrote ${content.length} bytes to ${path}`;
    },
  });

  const editFile = defineTool({
    name: "edit_file",
    description: "Replace exact text in a file.",
    schema: z.object({
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
    }),
    execute: ({ path, old_text, new_text }) => {
      const fp = safePath(path);
      const content = readFileSync(fp, "utf8");
      if (!content.includes(old_text))
        return `Error: Text not found in ${path}`;
      writeFileSync(fp, content.replace(old_text, new_text));
      return `Edited ${path}`;
    },
  });

  return [readFile, writeFile, editFile];
}
```

- [ ] **Step 7: Run test + typecheck**

Run: `pnpm --filter lite-agent test file`
Expected: PASS.
Run: `pnpm --filter lite-agent typecheck`
Expected: clean (build `@lite-agent/core` first if its `dist` types are missing).

- [ ] **Step 8: Commit**

```bash
git add packages/sdk pnpm-lock.yaml
git commit -m "feat(sdk): scaffold package + workspace-confined file tools"
```

---

## Task 5: bash + todo tools + default tool set

**Files:**

- Create: `packages/sdk/src/tools/bash.ts`
- Create: `packages/sdk/src/tools/todo.ts`
- Create: `packages/sdk/src/tools/index.ts`
- Test: `packages/sdk/test/tools.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/sdk/test/tools.test.ts`

```ts
import { expect, test } from "vitest";
import type { ToolContext } from "@lite-agent/core";
import { bashTool } from "../src/tools/bash";
import { todoTool } from "../src/tools/todo";
import { defaultTools } from "../src/tools";

const ctx: ToolContext = {
  sessionId: "s",
  signal: new AbortController().signal,
  emit: () => {},
};

test("bash runs commands and blocks dangerous ones", async () => {
  const bash = bashTool(process.cwd());
  expect(await bash.execute({ command: "echo hi" }, ctx)).toBe("hi");
  expect(await bash.execute({ command: "sudo rm -rf x" }, ctx)).toMatch(
    /Dangerous/,
  );
});

test("todo renders items and enforces a single in_progress", async () => {
  const todo = todoTool();
  const out = await todo.execute(
    { items: [{ id: "1", text: "a", status: "in_progress" }] },
    ctx,
  );
  expect(out).toContain("[>] #1: a");
  await expect(
    todo.execute(
      {
        items: [
          { id: "1", text: "a", status: "in_progress" },
          { id: "2", text: "b", status: "in_progress" },
        ],
      },
      ctx,
    ),
  ).rejects.toThrow(/in_progress/);
});

test("defaultTools exposes the five built-ins by name", () => {
  const names = defaultTools(process.cwd())
    .map((t) => t.name)
    .sort();
  expect(names).toEqual([
    "bash",
    "edit_file",
    "read_file",
    "todo",
    "write_file",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lite-agent test tools`
Expected: FAIL — `bashTool` not found.

- [ ] **Step 3: Implement `packages/sdk/src/tools/bash.ts`**

```ts
import { execSync } from "node:child_process";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";

const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

export function bashTool(workdir: string): Tool {
  return defineTool({
    name: "bash",
    description: "Run a shell command.",
    schema: z.object({ command: z.string() }),
    execute: ({ command }) => {
      if (DANGEROUS.some((d) => command.includes(d)))
        return "Error: Dangerous command blocked";
      try {
        const out = execSync(command, {
          cwd: workdir,
          encoding: "utf8",
          timeout: 120000,
          maxBuffer: 50_000_000,
        });
        return out.trim() || "(no output)";
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return (
          `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(0, 50_000) ||
          `Error: ${err.message}`
        );
      }
    },
  });
}
```

- [ ] **Step 4: Implement `packages/sdk/src/tools/todo.ts`**

```ts
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";

type TodoStatus = "pending" | "in_progress" | "completed";
interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

const MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

const itemSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
});

class TodoManager {
  private items: TodoItem[] = [];
  update(items: TodoItem[]): string {
    if (items.length > 20) throw new Error("Max 20 todos allowed");
    if (items.filter((t) => t.status === "in_progress").length > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }
    this.items = items;
    return this.render();
  }
  render(): string {
    if (!this.items.length) return "No todos.";
    const lines = this.items.map(
      (t) => `${MARK[t.status]} #${t.id}: ${t.text}`,
    );
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

export function todoTool(): Tool {
  const manager = new TodoManager();
  return defineTool({
    name: "todo",
    description: "Update the task list. Track progress on multi-step tasks.",
    schema: z.object({ items: z.array(itemSchema) }),
    execute: ({ items }) => manager.update(items),
  });
}
```

- [ ] **Step 5: Implement `packages/sdk/src/tools/index.ts`**

```ts
import type { Tool } from "@lite-agent/core";
import { bashTool } from "./bash";
import { fileTools } from "./file";
import { todoTool } from "./todo";

export function defaultTools(workdir: string): Tool[] {
  return [bashTool(workdir), ...fileTools(workdir), todoTool()];
}

export { bashTool } from "./bash";
export { fileTools, makeSafePath } from "./file";
export { todoTool } from "./todo";
```

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm --filter lite-agent test tools`
Expected: PASS.
Run: `pnpm --filter lite-agent typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): bash + todo tools and defaultTools set"
```

---

## Task 6: SkillLoader + load_skill tool

**Files:**

- Create: `packages/sdk/src/skills/loader.ts`
- Create: `packages/sdk/src/skills/loadSkillTool.ts`
- Test: `packages/sdk/test/skills.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/sdk/test/skills.test.ts`

```ts
import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@lite-agent/core";
import { SkillLoader } from "../src/skills/loader";
import { loadSkillTool } from "../src/skills/loadSkillTool";

const ctx: ToolContext = {
  sessionId: "s",
  signal: new AbortController().signal,
  emit: () => {},
};

test("loads frontmatter and serves the body via load_skill", async () => {
  const root = mkdtempSync(join(tmpdir(), "sk-"));
  mkdirSync(join(root, "demo"));
  writeFileSync(
    join(root, "demo", "SKILL.md"),
    "---\nname: demo\ndescription: a demo skill\n---\nBODY HERE",
  );

  const loader = new SkillLoader(root);
  expect(loader.getDescriptions()).toContain("demo: a demo skill");

  const tool = loadSkillTool(loader);
  expect(await tool.execute({ name: "demo" }, ctx)).toContain("BODY HERE");
  expect(await tool.execute({ name: "nope" }, ctx)).toMatch(/Unknown skill/);
});

test("empty/missing dir yields a placeholder description", () => {
  const loader = new SkillLoader(join(tmpdir(), "does-not-exist-xyz"));
  expect(loader.getDescriptions()).toBe("(no skills available)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lite-agent test skills`
Expected: FAIL — `SkillLoader` not found.

- [ ] **Step 3: Implement `packages/sdk/src/skills/loader.ts`**

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface SkillMeta {
  name?: string;
  description?: string;
  tags?: string;
  [k: string]: string | undefined;
}
interface Skill {
  meta: SkillMeta;
  body: string;
  path: string;
}

export class SkillLoader {
  readonly skillsDir: string;
  private skills: Record<string, Skill> = {};

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    this.loadAll();
  }

  private loadAll(): void {
    if (!existsSync(this.skillsDir)) return;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === "SKILL.md") {
          const { meta, body } = this.parse(readFileSync(p, "utf8"));
          const name = meta.name ?? dirname(p).split("/").pop() ?? p;
          this.skills[name] = { meta, body, path: p };
        }
      }
    };
    walk(this.skillsDir);
  }

  private parse(text: string): { meta: SkillMeta; body: string } {
    const m = text.match(/^---\n(.*?)\n---\n(.*)/s);
    if (!m) return { meta: {}, body: text };
    const meta: SkillMeta = {};
    for (const line of m[1]!.trim().split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { meta, body: m[2]!.trim() };
  }

  getDescriptions(): string {
    const names = Object.keys(this.skills);
    if (!names.length) return "(no skills available)";
    return names
      .map((n) => {
        const s = this.skills[n]!;
        const tags = s.meta.tags ? ` [${s.meta.tags}]` : "";
        return `  - ${n}: ${s.meta.description ?? "No description"}${tags}`;
      })
      .join("\n");
  }

  getContent(name: string): string {
    const s = this.skills[name];
    if (!s)
      return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    return `<skill name="${name}">\n${s.body}\n</skill>`;
  }
}
```

- [ ] **Step 4: Implement `packages/sdk/src/skills/loadSkillTool.ts`**

```ts
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";
import type { SkillLoader } from "./loader";

export function loadSkillTool(loader: SkillLoader): Tool {
  return defineTool({
    name: "load_skill",
    description:
      "Load a skill's full instructions by name before tackling an unfamiliar task.",
    schema: z.object({ name: z.string() }),
    execute: ({ name }) => loader.getContent(name),
  });
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter lite-agent test skills`
Expected: PASS.
Run: `pnpm --filter lite-agent typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): SkillLoader + load_skill tool"
```

---

## Task 7: System prompt + createLiteAgent + query/tool facade + exports

**Files:**

- Create: `packages/sdk/src/system.ts`
- Create: `packages/sdk/src/createLiteAgent.ts`
- Create: `packages/sdk/src/query.ts`
- Create: `packages/sdk/src/tool.ts`
- Create: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/system.test.ts`
- Test: `packages/sdk/test/createLiteAgent.test.ts`
- Test: `packages/sdk/test/query.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/sdk/test/system.test.ts`:

```ts
import { expect, test } from "vitest";
import { buildSystemPrompt } from "../src/system";

test("system prompt embeds workdir, model, skills, and load_skill hint", () => {
  const s = buildSystemPrompt({
    workdir: "/w",
    modelName: "m1",
    skills: "  - demo: x",
  });
  expect(s).toContain("/w");
  expect(s).toContain("m1");
  expect(s).toContain("- demo: x");
  expect(s).toContain("load_skill");
});
```

`packages/sdk/test/createLiteAgent.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";

test("runs with default tools wired", async () => {
  const agent = createLiteAgent({
    model: fakeProvider([
      {
        text: "ok",
        message: { role: "assistant", content: [textBlock("ok")] },
      },
    ]),
    workdir: process.cwd(),
  });
  expect((await agent.send("hi")).text).toBe("ok");
});

test("load_skill is wired when skillsDir is set", async () => {
  const root = mkdtempSync(join(tmpdir(), "sk-"));
  mkdirSync(join(root, "demo"));
  writeFileSync(
    join(root, "demo", "SKILL.md"),
    "---\nname: demo\ndescription: d\n---\nBODY",
  );
  const fp = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "load_skill",
            input: { name: "demo" },
          },
        ],
      },
    },
    {
      text: "done",
      message: { role: "assistant", content: [textBlock("done")] },
    },
  ]);
  const agent = createLiteAgent({
    model: fp,
    workdir: process.cwd(),
    skillsDir: root,
  });
  const results: string[] = [];
  for await (const ev of agent.run("hi"))
    if (ev.type === "tool_result") results.push(ev.result.content);
  expect(results.join("")).toContain("BODY");
});

test("allowedTools restricts the registered set", async () => {
  const fp = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "read_file",
            input: { path: "x" },
          },
        ],
      },
    },
    {
      text: "end",
      message: { role: "assistant", content: [textBlock("end")] },
    },
  ]);
  const agent = createLiteAgent({
    model: fp,
    workdir: process.cwd(),
    allowedTools: ["bash"],
  });
  const results: string[] = [];
  for await (const ev of agent.run("hi"))
    if (ev.type === "tool_result") results.push(ev.result.content);
  expect(results.join("")).toMatch(/unknown tool/);
});
```

`packages/sdk/test/query.test.ts`:

```ts
import { expect, test } from "vitest";
import { z } from "zod";
import { fakeProvider, textBlock } from "@lite-agent/core";
import { query } from "../src/query";
import { tool } from "../src/tool";

test("query() streams events and returns a result", async () => {
  const fp = fakeProvider([
    {
      text: "hi there",
      message: { role: "assistant", content: [textBlock("hi there")] },
    },
  ]);
  const types: string[] = [];
  const gen = query({ prompt: "hi", model: fp, cwd: process.cwd() });
  let r = await gen.next();
  while (!r.done) {
    types.push(r.value.type);
    r = await gen.next();
  }
  expect(types).toContain("done");
  expect(r.value.text).toBe("hi there");
});

test("tool() builds a working Tool", async () => {
  const t = tool(
    "double",
    "double a number",
    z.object({ n: z.number() }),
    ({ n }) => String(n * 2),
  );
  expect(t.name).toBe("double");
  const ctx = {
    sessionId: "s",
    signal: new AbortController().signal,
    emit: () => {},
  };
  expect(await t.execute({ n: 3 }, ctx)).toBe("6");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter lite-agent test system createLiteAgent query`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `packages/sdk/src/system.ts`**

```ts
export interface SystemPromptOptions {
  workdir: string;
  modelName?: string;
  skills: string;
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const modelLine = opts.modelName ? `Your model is ${opts.modelName}.\n` : "";
  return `You are lite-agent, a coding agent operating in ${opts.workdir}.
${modelLine}
## Core Principles
- Prefer tools over prose.
- Always work inside ${opts.workdir}; never access paths outside it.

## Task Planning
- For any task with 3+ steps, call the todo tool first to plan, then execute step by step.
- Mark todos as in_progress before starting each step, and completed when done.

## Skills
Use load_skill to access specialized knowledge before tackling unfamiliar topics.
Available skills:
${opts.skills}`;
}
```

- [ ] **Step 4: Implement `packages/sdk/src/createLiteAgent.ts`**

```ts
import { createAgent, nativeCodec } from "@lite-agent/core";
import type { Agent, Middleware, ModelProvider, Tool } from "@lite-agent/core";
import { defaultTools } from "./tools";
import { SkillLoader } from "./skills/loader";
import { loadSkillTool } from "./skills/loadSkillTool";
import { buildSystemPrompt } from "./system";

export interface CreateLiteAgentConfig {
  model: ModelProvider;
  modelName?: string;
  workdir: string;
  skillsDir?: string;
  tools?: Tool[];
  system?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxTokens?: number;
  use?: Middleware[];
}

export function createLiteAgent(cfg: CreateLiteAgentConfig): Agent {
  let tools: Tool[] = [...defaultTools(cfg.workdir)];
  let skills = "(no skills available)";

  if (cfg.skillsDir) {
    const loader = new SkillLoader(cfg.skillsDir);
    tools.push(loadSkillTool(loader));
    skills = loader.getDescriptions();
  }
  if (cfg.tools) tools.push(...cfg.tools);
  if (cfg.allowedTools)
    tools = tools.filter((t) => cfg.allowedTools!.includes(t.name));
  if (cfg.disallowedTools)
    tools = tools.filter((t) => !cfg.disallowedTools!.includes(t.name));

  const system =
    cfg.system ??
    buildSystemPrompt({
      workdir: cfg.workdir,
      modelName: cfg.modelName,
      skills,
    });

  return createAgent({
    model: cfg.model,
    modelName: cfg.modelName,
    codec: nativeCodec(),
    tools,
    use: cfg.use,
    system,
    maxTurns: cfg.maxTurns,
    maxTokens: cfg.maxTokens,
  });
}
```

- [ ] **Step 5: Implement `packages/sdk/src/query.ts`**

```ts
import type {
  AgentEvent,
  Message,
  Middleware,
  ModelProvider,
  RunResult,
  Tool,
} from "@lite-agent/core";
import { createLiteAgent } from "./createLiteAgent";

export interface QueryOptions {
  prompt: string | Message[];
  model: ModelProvider;
  modelName?: string;
  cwd?: string;
  systemPrompt?: string;
  skillsDir?: string;
  tools?: Tool[];
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxTokens?: number;
  use?: Middleware[];
  signal?: AbortSignal;
  sessionId?: string;
}

export function query(
  opts: QueryOptions,
): AsyncGenerator<AgentEvent, RunResult> {
  const agent = createLiteAgent({
    model: opts.model,
    modelName: opts.modelName,
    workdir: opts.cwd ?? process.cwd(),
    skillsDir: opts.skillsDir,
    tools: opts.tools,
    system: opts.systemPrompt,
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    maxTurns: opts.maxTurns,
    maxTokens: opts.maxTokens,
    use: opts.use,
  });
  return agent.run(opts.prompt, {
    signal: opts.signal,
    sessionId: opts.sessionId,
  });
}
```

- [ ] **Step 6: Implement `packages/sdk/src/tool.ts`**

```ts
import type { ZodType } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool, ToolContext } from "@lite-agent/core";

export function tool<I>(
  name: string,
  description: string,
  schema: ZodType<I>,
  handler: (input: I, ctx: ToolContext) => Promise<string> | string,
): Tool<I> {
  return defineTool({ name, description, schema, execute: handler });
}
```

- [ ] **Step 7: Implement `packages/sdk/src/index.ts`**

```ts
export * from "@lite-agent/core";

export { createLiteAgent } from "./createLiteAgent";
export type { CreateLiteAgentConfig } from "./createLiteAgent";
export { query } from "./query";
export type { QueryOptions } from "./query";
export { tool } from "./tool";
export { buildSystemPrompt } from "./system";
export type { SystemPromptOptions } from "./system";
export {
  defaultTools,
  bashTool,
  fileTools,
  todoTool,
  makeSafePath,
} from "./tools";
export { SkillLoader } from "./skills/loader";
export { loadSkillTool } from "./skills/loadSkillTool";
```

- [ ] **Step 8: Run tests + typecheck + build**

Run: `pnpm --filter lite-agent test`
Expected: PASS (all sdk test files).
Run: `pnpm --filter lite-agent typecheck`
Expected: clean.
Run: `pnpm --filter lite-agent build`
Expected: emits `dist/index.js` + `dist/index.d.ts`. Exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): createLiteAgent + query/tool facade + public exports"
```

---

## Task 8: Rewrite outer `src/` CLI; remove old code; update root config

**Files:**

- Delete: `src/agent/` (whole dir), `src/tools/` (whole dir), `src/prompt/` (whole dir), `src/monitor.ts`
- Rewrite: `src/main.ts`
- Modify: `package.json` (root)

- [ ] **Step 1: Remove the old demo code**

```bash
rm -rf src/agent src/tools src/prompt src/monitor.ts
```

Expected: `src/` now contains only `main.ts`.

- [ ] **Step 2: Update root `package.json`**

Replace the file with (sets the app to ESM, swaps deps to the workspace packages):

```json
{
  "name": "lite-agent",
  "version": "1.0.0",
  "description": "",
  "type": "module",
  "main": "dist/main.js",
  "scripts": {
    "dev": "tsx src/main.ts",
    "build": "tsc",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "packageManager": "pnpm@10.12.4",
  "devDependencies": {
    "@types/node": "^25.5.0",
    "tsx": "^4.21.0",
    "typescript": "^6.0.2"
  },
  "dependencies": {
    "@lite-agent/provider": "workspace:*",
    "lite-agent": "workspace:*",
    "dotenv": "^17.3.1"
  }
}
```

- [ ] **Step 3: Rewrite `src/main.ts`**

```ts
import "dotenv/config";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { anthropic } from "@lite-agent/provider";
import { createLiteAgent } from "lite-agent";
import type { AgentEvent, Message } from "lite-agent";

const workdir = process.cwd();

const agent = createLiteAgent({
  model: anthropic(),
  modelName: process.env["MODEL_ID"],
  workdir,
  skillsDir: join(workdir, "skills"),
});

function render(ev: AgentEvent): void {
  switch (ev.type) {
    case "text_delta":
      process.stdout.write(ev.text);
      break;
    case "tool_use":
      process.stdout.write(
        `\n\x1b[32m[tool] ${ev.call.name} ${JSON.stringify(ev.call.input)}\x1b[0m\n`,
      );
      break;
    case "tool_result": {
      const body =
        ev.result.content.length > 500
          ? `${ev.result.content.slice(0, 500)}…`
          : ev.result.content;
      process.stdout.write(`\x1b[90m${body}\x1b[0m\n`);
      break;
    }
    case "error":
      process.stdout.write(`\n\x1b[31m[error] ${ev.error.message}\x1b[0m\n`);
      break;
    case "done":
      process.stdout.write("\n");
      break;
    default:
      break;
  }
}

function readPrompt(rl: ReturnType<typeof createInterface>): Promise<string> {
  return new Promise((resolvePromise) => {
    const lines: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let multiline = false;

    const submit = () => {
      rl.removeListener("line", onLine);
      resolvePromise(lines.join("\n"));
    };
    const onLine = (line: string) => {
      if (multiline) {
        if (line === "") submit();
        else {
          lines.push(line);
          process.stdout.write("\x1b[90m...  \x1b[0m");
        }
        return;
      }
      if (timer) clearTimeout(timer);
      lines.push(line);
      timer = setTimeout(() => {
        if (lines.length > 1) {
          multiline = true;
          process.stdout.write(
            "\x1b[90m[multi-line: blank line submits]\x1b[0m\n\x1b[90m...  \x1b[0m",
          );
        } else {
          submit();
        }
      }, 50);
    };

    process.stdout.write("\x1b[36mlite-agent >> \x1b[0m");
    rl.on("line", onLine);
  });
}

async function main(): Promise<void> {
  let history: Message[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const text = (await readPrompt(rl)).trim();
    if (!text || ["q", "exit"].includes(text.toLowerCase())) break;
    history.push({ role: "user", content: text });

    const ac = new AbortController();
    rl.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = (key: Buffer) => {
      if (key[0] === 0x1b && key.length === 1) {
        ac.abort();
        process.stdout.write("\n\x1b[33m[ESC] interrupted\x1b[0m\n");
      }
    };
    process.stdin.on("data", onKey);

    try {
      const gen = agent.run(history, { signal: ac.signal });
      let r = await gen.next();
      while (!r.done) {
        render(r.value);
        r = await gen.next();
      }
      history = r.value.messages;
    } catch (e) {
      process.stdout.write(
        `\n\x1b[31m[error] ${(e as Error).message}\x1b[0m\n`,
      );
    } finally {
      process.stdin.removeListener("data", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      rl.resume();
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 4: Install + build the workspace libraries**

Run: `pnpm install`
Expected: links the new root deps. Exit 0.
Run: `pnpm -r --filter "@lite-agent/core" --filter "@lite-agent/provider" --filter "lite-agent" build`
Expected: builds the three libs in dependency order; each emits `dist/`. Exit 0.

- [ ] **Step 5: Typecheck the app**

Run: `pnpm typecheck`
Expected: clean (the app resolves `lite-agent` + `@lite-agent/provider` types from their built `dist`).

- [ ] **Step 6: Smoke-run the REPL (no network)**

Run: `printf 'q\n' | ANTHROPIC_API_KEY=test MODEL_ID=test pnpm dev`
Expected: prints `lite-agent >> ` then exits 0 (constructs the Anthropic client and agent, reads `q`, quits — the client never makes a network call).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(app): rewrite CLI on lite-agent + provider-anthropic; remove old demo"
```

---

## Final verification (after all tasks)

- [ ] `pnpm -r --filter "@lite-agent/core" --filter "@lite-agent/provider" --filter "lite-agent" test` — all package tests pass.
- [ ] `pnpm -r --filter "@lite-agent/core" --filter "@lite-agent/provider" --filter "lite-agent" typecheck` — clean.
- [ ] `pnpm typecheck` (root app) — clean.
- [ ] `printf 'q\n' | ANTHROPIC_API_KEY=test MODEL_ID=test pnpm dev` — exits 0.
- [ ] Manual end-to-end (user, with a real `.env`): `pnpm dev`, ask a question, confirm streaming text + a tool call (e.g. "list files with bash") + skill load works.
