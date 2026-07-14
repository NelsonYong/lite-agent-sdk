# Provider Conformance and Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small reusable `ModelProvider` contract suite, run it offline against Anthropic and OpenAI, and add an explicitly opt-in OpenAI-compatible endpoint probe with honest bilingual support documentation.

**Architecture:** Keep the existing Strategy (`ModelProvider`), Adapter (provider mapping/stream translators), and Dependency Injection (`client`) boundaries unchanged. Add one flat, framework-neutral Contract Test array in core, two explicit provider-specific fixture drivers in provider tests, and one separately discovered Vitest smoke profile. Do not add production provider abstractions or refactor adapters to remove test-only duplication.

**Tech Stack:** TypeScript 6 strict ESM, Node.js 20+, Vitest 2, pnpm 10.12.4, `node:assert/strict`, existing Anthropic and OpenAI SDK client seams.

## Global Constraints

- Follow the approved spec at `docs/superpowers/specs/2026-07-14-provider-conformance-design.md`.
- Use TDD: observe the intended failure before adding the minimum implementation for each task.
- No new runtime dependency, provider SDK, provider factory, normalized model capability, registry, base class, capability resolver, plugin framework, test DSL, builder, or generic fixture engine.
- Reuse the existing `ModelProvider` Strategy, provider Adapter files, injected `client` seam, and flat `checkpointerConformance` Contract Test pattern.
- Keep provider-native request mapping and stream-fragment edge cases in their existing adapter-specific tests.
- Keep the current malformed-tool-JSON behaviors unchanged: Anthropic rejects malformed JSON; OpenAI falls back to `{}`.
- Default package and workspace tests must never discover or execute the network-capable compatibility smoke file.
- The compatibility probe must not persist credentials, prompts, endpoint output, or test results.
- Build `@lite-agent/core` before testing the dependent `@lite-agent/provider` package.
- English and Simplified Chinese provider documentation must make the same support claims.
- Do not bump package versions or edit changelogs; this task is not a release request.

## File structure

```text
packages/core/src/testing/providerConformance.ts        # public framework-neutral contract cases
packages/core/src/index.ts                              # public exports only
packages/core/test/provider-conformance.test.ts         # contract-suite self-test
packages/provider/test/conformance.test.ts              # runs shared cases for maintained adapters
packages/provider/test/support/openaiConformance.ts     # OpenAI injected-client fixture driver
packages/provider/test/support/anthropicConformance.ts  # Anthropic injected-client fixture driver
packages/provider/test/compat/openai-compatible.smoke.ts # opt-in real-endpoint assertions
packages/provider/vitest.compat.config.ts               # discovers only the smoke file
packages/provider/package.json                          # test:compat command
packages/provider/README.md                             # English levels, matrix, probe, API correction
packages/provider/README.zh-CN.md                       # matching Chinese documentation
```

---

### Task 1: Framework-neutral provider contract suite

**Files:**
- Create: `packages/core/test/provider-conformance.test.ts`
- Create: `packages/core/src/testing/providerConformance.ts`
- Modify: `packages/core/src/index.ts:10-13`

**Interfaces:**
- Consumes: existing `ModelProvider`, `ModelRequest`, `ModelChunk`, `ToolCall`, `Usage`, and `ProviderError` exports from core.
- Produces: `ProviderConformanceScenario`, `ProviderConformanceFactory`, and `providerConformance` from `@lite-agent/core`.

- [ ] **Step 1: Write the failing core self-test**

Create `packages/core/test/provider-conformance.test.ts` with a minimal scripted provider. It intentionally imports the not-yet-created contract module:

```ts
import { test } from "vitest";
import { ProviderError } from "../src/events";
import type { ModelProvider } from "../src/strategies";
import type { ContentBlock } from "../src/types";
import {
  providerConformance,
  type ProviderConformanceFactory,
  type ProviderConformanceScenario,
} from "../src/testing/providerConformance";

function providerError(error: unknown): ProviderError {
  const status = typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
  return new ProviderError(error instanceof Error ? error.message : String(error), status);
}

const scriptedProvider: ProviderConformanceFactory = (
  scenario: ProviderConformanceScenario,
): ModelProvider => ({
  id: "scripted",
  async *stream(_req, signal) {
    if (scenario.kind === "abort") {
      if (!signal) {
        await new Promise<never>(() => {});
        return;
      }
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return;
    }

    if (scenario.kind === "error") {
      if (scenario.afterText) {
        yield { type: "text_delta", text: scenario.afterText };
      }
      throw providerError(scenario.error);
    }

    for (const text of scenario.kind === "text"
      ? scenario.deltas
      : scenario.textDeltas) {
      yield { type: "text_delta", text };
    }

    const content: ContentBlock[] = [];
    const text = (scenario.kind === "text"
      ? scenario.deltas
      : scenario.textDeltas).join("");
    if (text) content.push({ type: "text", text });
    if (scenario.kind === "tool") {
      content.push({ type: "tool_call", ...scenario.call });
    }

    yield {
      type: "message_done",
      message: { role: "assistant", content },
      usage: scenario.usage,
    };
  },
});

for (const contract of providerConformance) {
  test(`provider conformance self-test: ${contract.name}`, async () => {
    await contract.run(scriptedProvider);
  });
}
```

- [ ] **Step 2: Run the focused test and verify the intended failure**

Run:

```bash
pnpm --filter @lite-agent/core test -- provider-conformance
```

Expected: FAIL because `../src/testing/providerConformance` does not exist.

- [ ] **Step 3: Implement the minimal flat contract array**

Create `packages/core/src/testing/providerConformance.ts`:

```ts
import assert from "node:assert/strict";
import { ProviderError } from "../events";
import type { ModelProvider } from "../strategies";
import type {
  ModelChunk,
  ModelRequest,
  ToolCall,
  Usage,
} from "../types";

export type ProviderConformanceScenario =
  | { kind: "text"; deltas: string[]; usage: Usage }
  | {
      kind: "tool";
      textDeltas: string[];
      call: ToolCall;
      usage: Usage;
    }
  | { kind: "error"; error: unknown; afterText?: string }
  | { kind: "abort" };

export type ProviderConformanceFactory = (
  scenario: ProviderConformanceScenario,
) => ModelProvider;

const request: ModelRequest = {
  model: "conformance-model",
  messages: [{ role: "user", content: "conformance request" }],
};

async function collect(
  provider: ModelProvider,
  signal?: AbortSignal,
): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of provider.stream(request, signal)) chunks.push(chunk);
  return chunks;
}

function assertProviderError(error: unknown, status: number): boolean {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.status, status);
  return true;
}

export const providerConformance: Array<{
  name: string;
  run(make: ProviderConformanceFactory): Promise<void>;
}> = [
  {
    name: "has an id and emits exactly one final message_done",
    run: async (make) => {
      const provider = make({
        kind: "text",
        deltas: ["ok"],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      assert.ok(provider.id.length > 0);
      const chunks = await collect(provider);
      const doneIndexes = chunks.flatMap((chunk, index) =>
        chunk.type === "message_done" ? [index] : [],
      );
      assert.deepEqual(doneIndexes, [chunks.length - 1]);
    },
  },
  {
    name: "preserves text delta order in the final text block",
    run: async (make) => {
      const chunks = await collect(make({
        kind: "text",
        deltas: ["Hel", "lo"],
        usage: { inputTokens: 2, outputTokens: 2 },
      }));
      assert.deepEqual(
        chunks.filter((chunk) => chunk.type === "text_delta"),
        [
          { type: "text_delta", text: "Hel" },
          { type: "text_delta", text: "lo" },
        ],
      );
      const done = chunks.at(-1);
      assert.equal(done?.type, "message_done");
      if (done?.type === "message_done") {
        assert.deepEqual(done.message.content, [
          { type: "text", text: "Hello" },
        ]);
      }
    },
  },
  {
    name: "normalizes text followed by one tool call",
    run: async (make) => {
      const call: ToolCall = {
        id: "call-1",
        name: "echo",
        input: { value: "ok" },
      };
      const chunks = await collect(make({
        kind: "tool",
        textDeltas: ["Calling"],
        call,
        usage: { inputTokens: 3, outputTokens: 4 },
      }));
      const done = chunks.at(-1);
      assert.equal(done?.type, "message_done");
      if (done?.type === "message_done") {
        assert.deepEqual(done.message.content, [
          { type: "text", text: "Calling" },
          { type: "tool_call", ...call },
        ]);
      }
    },
  },
  {
    name: "reports normalized input and output usage",
    run: async (make) => {
      const chunks = await collect(make({
        kind: "text",
        deltas: ["usage"],
        usage: { inputTokens: 11, outputTokens: 7 },
      }));
      const done = chunks.at(-1);
      assert.equal(done?.type, "message_done");
      if (done?.type === "message_done") {
        assert.deepEqual(done.usage, { inputTokens: 11, outputTokens: 7 });
      }
    },
  },
  {
    name: "settles within 1000 ms after abort",
    run: async (make) => {
      const controller = new AbortController();
      const iterator = make({ kind: "abort" })
        .stream(request, controller.signal)[Symbol.asyncIterator]();
      const pending = iterator.next();
      let settled = false;
      const outcome = pending.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(settled, false, "provider stream settled before abort");
      controller.abort();

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          outcome,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("provider stream did not settle after abort")),
              1_000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  },
  {
    name: "normalizes errors before and during streaming",
    run: async (make) => {
      const before = Object.assign(new Error("rate limited"), { status: 429 });
      await assert.rejects(
        () => collect(make({ kind: "error", error: before })),
        (error) => assertProviderError(error, 429),
      );

      const during = Object.assign(new Error("upstream failed"), { status: 503 });
      const seen: ModelChunk[] = [];
      await assert.rejects(async () => {
        for await (const chunk of make({
          kind: "error",
          error: during,
          afterText: "partial",
        }).stream(request)) {
          seen.push(chunk);
        }
      }, (error) => assertProviderError(error, 503));
      assert.deepEqual(seen, [{ type: "text_delta", text: "partial" }]);
    },
  },
];
```

- [ ] **Step 4: Export only the contract utility and its public types**

Add after the existing `checkpointerConformance` export in `packages/core/src/index.ts`:

```ts
export { providerConformance } from "./testing/providerConformance";
export type {
  ProviderConformanceFactory,
  ProviderConformanceScenario,
} from "./testing/providerConformance";
```

- [ ] **Step 5: Run focused verification**

Run:

```bash
pnpm --filter @lite-agent/core test -- provider-conformance
pnpm --filter @lite-agent/core typecheck
pnpm --filter @lite-agent/core build
```

Expected: six focused conformance self-tests pass; core typecheck and build succeed.

- [ ] **Step 6: Commit the core contract suite**

```bash
git add packages/core/src/testing/providerConformance.ts packages/core/src/index.ts packages/core/test/provider-conformance.test.ts
git commit -m "test(core): add provider conformance contract"
```

---

### Task 2: OpenAI adapter conformance driver

**Files:**
- Create: `packages/provider/test/conformance.test.ts`
- Create: `packages/provider/test/support/openaiConformance.ts`

**Interfaces:**
- Consumes: `providerConformance`, `ProviderConformanceFactory`, and `ProviderConformanceScenario` from Task 1; existing `openai({ client })` injection seam.
- Produces: `openaiConformance`, a test-only `ProviderConformanceFactory` used by the shared provider test entry point.

- [ ] **Step 1: Add the failing OpenAI conformance registration**

Create `packages/provider/test/conformance.test.ts`:

```ts
import { test } from "vitest";
import { providerConformance } from "@lite-agent/core";
import { openaiConformance } from "./support/openaiConformance";

for (const contract of providerConformance) {
  test(`openai provider: ${contract.name}`, async () => {
    await contract.run(openaiConformance);
  });
}
```

- [ ] **Step 2: Build core, run the provider test, and verify the intended failure**

Run:

```bash
pnpm --filter @lite-agent/core build
pnpm --filter @lite-agent/provider test -- conformance
```

Expected: FAIL because `./support/openaiConformance` does not exist.

- [ ] **Step 3: Implement the explicit injected OpenAI client driver**

Create `packages/provider/test/support/openaiConformance.ts`:

```ts
import type OpenAI from "openai";
import type {
  ProviderConformanceFactory,
  ProviderConformanceScenario,
} from "@lite-agent/core";
import { openai } from "../../src/openai";
import type { OpenAIClientLike } from "../../src/openai";

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;

const chunk = (value: unknown): Chunk => value as Chunk;

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => {});
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function* events(
  scenario: ProviderConformanceScenario,
  signal?: AbortSignal,
): AsyncIterable<Chunk> {
  if (scenario.kind === "abort") {
    await waitForAbort(signal);
    throw new Error("aborted");
  }

  if (scenario.kind === "error") {
    if (scenario.afterText) {
      yield chunk({ choices: [{ delta: { content: scenario.afterText } }] });
    }
    throw scenario.error;
  }

  const deltas = scenario.kind === "text"
    ? scenario.deltas
    : scenario.textDeltas;
  for (const text of deltas) {
    yield chunk({ choices: [{ delta: { content: text } }] });
  }

  if (scenario.kind === "tool") {
    yield chunk({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: scenario.call.id,
            function: {
              name: scenario.call.name,
              arguments: JSON.stringify(scenario.call.input),
            },
          }],
        },
      }],
    });
  }

  yield chunk({
    choices: [{ delta: {} }],
    usage: {
      prompt_tokens: scenario.usage.inputTokens,
      completion_tokens: scenario.usage.outputTokens,
    },
  });
}

export const openaiConformance: ProviderConformanceFactory = (scenario) => {
  const client: OpenAIClientLike = {
    chat: {
      completions: {
        create(_params, options) {
          return events(scenario, options?.signal);
        },
      },
    },
  };
  return openai({ client });
};
```

- [ ] **Step 4: Run OpenAI conformance and existing OpenAI tests**

Run:

```bash
pnpm --filter @lite-agent/provider test -- conformance
pnpm --filter @lite-agent/provider test -- openai
pnpm --filter @lite-agent/provider typecheck
```

Expected: six OpenAI conformance cases pass; existing OpenAI mapping, stream, and factory tests pass; provider typecheck succeeds.

- [ ] **Step 5: Commit the OpenAI driver**

```bash
git add packages/provider/test/conformance.test.ts packages/provider/test/support/openaiConformance.ts
git commit -m "test(provider): apply conformance suite to OpenAI"
```

---

### Task 3: Anthropic adapter conformance driver

**Files:**
- Create: `packages/provider/test/support/anthropicConformance.ts`
- Modify: `packages/provider/test/conformance.test.ts`

**Interfaces:**
- Consumes: the Task 1 contract types and existing `anthropic({ client })` injection seam.
- Produces: `anthropicConformance`, a test-only `ProviderConformanceFactory`; the shared entry point runs every case for both maintained adapters.

- [ ] **Step 1: Register Anthropic before its driver exists**

Replace `packages/provider/test/conformance.test.ts` with:

```ts
import { test } from "vitest";
import {
  providerConformance,
  type ProviderConformanceFactory,
} from "@lite-agent/core";
import { anthropicConformance } from "./support/anthropicConformance";
import { openaiConformance } from "./support/openaiConformance";

const providers: Array<{
  name: string;
  make: ProviderConformanceFactory;
}> = [
  { name: "openai", make: openaiConformance },
  { name: "anthropic", make: anthropicConformance },
];

for (const provider of providers) {
  for (const contract of providerConformance) {
    test(`${provider.name} provider: ${contract.name}`, async () => {
      await contract.run(provider.make);
    });
  }
}
```

- [ ] **Step 2: Run the focused test and verify the intended failure**

Run:

```bash
pnpm --filter @lite-agent/provider test -- conformance
```

Expected: FAIL because `./support/anthropicConformance` does not exist.

- [ ] **Step 3: Implement the explicit injected Anthropic client driver**

Create `packages/provider/test/support/anthropicConformance.ts`:

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type {
  ProviderConformanceFactory,
  ProviderConformanceScenario,
} from "@lite-agent/core";
import { anthropic } from "../../src/anthropic";
import type { AnthropicClientLike } from "../../src/anthropic";

type Event = Anthropic.RawMessageStreamEvent;

const event = (value: unknown): Event => value as Event;

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => {});
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function* events(
  scenario: ProviderConformanceScenario,
  signal?: AbortSignal,
): AsyncIterable<Event> {
  if (scenario.kind === "abort") {
    await waitForAbort(signal);
    throw new Error("aborted");
  }

  if (scenario.kind === "error") {
    if (scenario.afterText) {
      yield event({
        type: "message_start",
        message: { usage: { input_tokens: 1, output_tokens: 0 } },
      });
      yield event({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      yield event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: scenario.afterText },
      });
    }
    throw scenario.error;
  }

  yield event({
    type: "message_start",
    message: {
      usage: { input_tokens: scenario.usage.inputTokens, output_tokens: 0 },
    },
  });

  const deltas = scenario.kind === "text"
    ? scenario.deltas
    : scenario.textDeltas;
  let index = 0;
  if (deltas.length > 0) {
    yield event({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    for (const text of deltas) {
      yield event({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text },
      });
    }
    yield event({ type: "content_block_stop", index });
    index += 1;
  }

  if (scenario.kind === "tool") {
    yield event({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: scenario.call.id,
        name: scenario.call.name,
        input: {},
      },
    });
    yield event({
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(scenario.call.input),
      },
    });
    yield event({ type: "content_block_stop", index });
  }

  yield event({
    type: "message_delta",
    delta: {},
    usage: { output_tokens: scenario.usage.outputTokens },
  });
  yield event({ type: "message_stop" });
}

export const anthropicConformance: ProviderConformanceFactory = (scenario) => {
  const client: AnthropicClientLike = {
    messages: {
      create(_params, options) {
        return events(scenario, options?.signal);
      },
    },
  };
  return anthropic({ client });
};
```

- [ ] **Step 4: Run both adapter suites and existing Anthropic tests**

Run:

```bash
pnpm --filter @lite-agent/provider test -- conformance
pnpm --filter @lite-agent/provider test -- anthropic
pnpm --filter @lite-agent/provider typecheck
```

Expected: twelve shared conformance cases pass; existing Anthropic mapping, stream, and factory tests pass; provider typecheck succeeds.

- [ ] **Step 5: Commit the Anthropic driver**

```bash
git add packages/provider/test/conformance.test.ts packages/provider/test/support/anthropicConformance.ts
git commit -m "test(provider): apply conformance suite to Anthropic"
```

---

### Task 4: Explicitly isolated OpenAI-compatible smoke profile

**Files:**
- Modify: `packages/provider/package.json:39-43`
- Create: `packages/provider/vitest.compat.config.ts`
- Create: `packages/provider/test/compat/openai-compatible.smoke.ts`

**Interfaces:**
- Consumes: existing `openai({ apiKey, baseURL })`, `ModelRequest`, and `ModelChunk`.
- Produces: `pnpm --filter @lite-agent/provider test:compat`; no production or package-root export.

- [ ] **Step 1: Add a script that points to the not-yet-created isolated config**

Add one script to `packages/provider/package.json`:

```json
"scripts": {
  "build": "tsup src/index.ts --format esm --dts --clean --tsconfig tsconfig.build.json",
  "test": "vitest run",
  "test:compat": "vitest run --config vitest.compat.config.ts",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 2: Run the compatibility command and verify the intended failure**

Run:

```bash
pnpm --filter @lite-agent/provider test:compat
```

Expected: FAIL because `vitest.compat.config.ts` does not exist.

- [ ] **Step 3: Add the dedicated Vitest discovery config**

Create `packages/provider/vitest.compat.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/compat/**/*.smoke.ts"],
    testTimeout: 120_000,
  },
});
```

- [ ] **Step 4: Add the endpoint smoke assertions**

Create `packages/provider/test/compat/openai-compatible.smoke.ts`:

```ts
import { expect, test } from "vitest";
import type { ModelChunk, ModelRequest } from "@lite-agent/core";
import { openai } from "../../src/openai";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for test:compat`);
  return value;
}

function optionalBoolean(name: string): boolean {
  const value = process.env[name];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false`);
}

const baseURL = required("LITE_AGENT_COMPAT_BASE_URL");
const model = required("LITE_AGENT_COMPAT_MODEL");
const apiKey = process.env["LITE_AGENT_COMPAT_API_KEY"] ?? "local";
const forcedTool = optionalBoolean("LITE_AGENT_COMPAT_FORCED_TOOL");
const provider = openai({ apiKey, baseURL });

async function collect(req: ModelRequest): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of provider.stream(req, AbortSignal.timeout(110_000))) {
    chunks.push(chunk);
  }
  return chunks;
}

test("streams text and emits one final normalized message", async () => {
  const chunks = await collect({
    model,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
    maxTokens: 32,
    temperature: 0,
  });
  const deltas = chunks.flatMap((chunk) =>
    chunk.type === "text_delta" ? [chunk.text] : [],
  );
  expect(deltas.length).toBeGreaterThan(0);

  const done = chunks.filter(
    (chunk): chunk is Extract<ModelChunk, { type: "message_done" }> =>
      chunk.type === "message_done",
  );
  expect(done).toHaveLength(1);
  const final = done[0];
  if (!final) throw new Error("missing message_done");
  expect(chunks.at(-1)).toEqual(final);

  const finalText = final.message.content.flatMap((block) =>
    block.type === "text" ? [block.text] : [],
  ).join("");
  expect(finalText).toBe(deltas.join(""));
  expect(Number.isFinite(final.usage.inputTokens)).toBe(true);
  expect(Number.isFinite(final.usage.outputTokens)).toBe(true);
  expect(final.usage.inputTokens).toBeGreaterThanOrEqual(0);
  expect(final.usage.outputTokens).toBeGreaterThanOrEqual(0);
  if (final.usage.inputTokens + final.usage.outputTokens === 0) {
    console.warn("compatibility profile: endpoint did not report token usage");
  }
});

if (forcedTool) {
  test("supports forced selection of a named tool", async () => {
    const chunks = await collect({
      model,
      messages: [{
        role: "user",
        content: "Call the echo tool with value pong. Do not answer in text.",
      }],
      tools: [{
        name: "echo",
        description: "Echo a string value",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      }],
      toolChoice: { tool: "echo" },
      maxTokens: 64,
      temperature: 0,
    });
    const final = chunks.at(-1);
    if (final?.type !== "message_done") throw new Error("missing message_done");
    const call = final.message.content.find(
      (block) => block.type === "tool_call",
    );
    expect(call).toMatchObject({
      type: "tool_call",
      name: "echo",
      input: { value: "pong" },
    });
  });
}
```

- [ ] **Step 5: Verify missing configuration fails before client construction**

Run while explicitly removing the compatibility variables from the command's
environment:

```bash
env -u LITE_AGENT_COMPAT_BASE_URL -u LITE_AGENT_COMPAT_MODEL -u LITE_AGENT_COMPAT_API_KEY -u LITE_AGENT_COMPAT_FORCED_TOOL pnpm --filter @lite-agent/provider test:compat
```

Expected: FAIL with `LITE_AGENT_COMPAT_BASE_URL is required for test:compat`; there is no network request.

- [ ] **Step 6: Prove default tests cannot discover the smoke profile**

Run default tests while deliberately setting an unreachable compatibility endpoint:

```bash
LITE_AGENT_COMPAT_BASE_URL=http://127.0.0.1:1/v1 LITE_AGENT_COMPAT_MODEL=unreachable pnpm --filter @lite-agent/provider exec vitest run --reporter=verbose
```

Expected: all offline provider tests pass; output contains no `openai-compatible.smoke` test and no connection attempt.

- [ ] **Step 7: Record evidence when a real endpoint is supplied**

When the operator intentionally supplies a real endpoint, run `test:compat`
with those supplied environment values. Record the runtime version, model id,
execution date, and whether the text and forced-tool profiles passed in the
task handoff or pull-request notes. Never record the API key. This conditional
probe is not required for offline completion.

- [ ] **Step 8: Run provider typecheck and commit**

```bash
pnpm --filter @lite-agent/provider typecheck
git add packages/provider/package.json packages/provider/vitest.compat.config.ts packages/provider/test/compat/openai-compatible.smoke.ts
git commit -m "test(provider): add opt-in compatibility probe"
```

---

### Task 5: Honest bilingual support documentation and full verification

**Files:**
- Modify: `packages/provider/README.md:47-60`
- Modify: `packages/provider/README.zh-CN.md:47-60`

**Interfaces:**
- Consumes: support levels and environment variables implemented in Task 4.
- Produces: matching English and Chinese compatibility claims; no code interface.

- [ ] **Step 1: Correct the English public-export claim**

Replace the final paragraph under `## Options` in `packages/provider/README.md` with:

```markdown
The package root exports both factories and their option/client types
(`AnthropicProviderOptions`, `AnthropicClientLike`, `OpenAIProviderOptions`,
`OpenAIClientLike`). Request mappers and stream translators are internal adapter
details and are not public package-root exports.
```

- [ ] **Step 2: Add the English support matrix and probe instructions**

Insert before the monorepo architecture link in `packages/provider/README.md`:

```markdown
## Support levels

| Level | Meaning |
| --- | --- |
| Maintained adapter | Repository-owned request mapping and stream translation; passes the offline shared conformance suite. |
| Maintained preset | Repository-owned endpoint/configuration preset using a maintained adapter; runtime and model capabilities still vary. |
| Compatible endpoint | User-supplied endpoint expected to speak the protocol; best-effort until that exact runtime/model profile is probed. |

| Integration | Level | Notes |
| --- | --- | --- |
| Anthropic Messages | Maintained adapter | Text streaming, tool calls, normalized usage, abort propagation, and `ProviderError` normalization are covered offline. |
| OpenAI Chat Completions | Maintained adapter | The same shared offline contract is applied. |
| Ollama, vLLM, LM Studio, llama.cpp | Maintained preset in [`@lite-agent/local`](../local) | Uses the OpenAI-compatible adapter; native tool and usage support depend on the selected runtime and model. |
| Other OpenAI-compatible endpoints | Compatible endpoint | Not verified by default; run the profile below against the exact endpoint and model. |

"Compatible" is not a blanket certification. Servers differ in streaming,
`stream_options`, tool-choice, usage, and error behavior.

## Probe an OpenAI-compatible endpoint

The probe is deliberately excluded from normal tests and runs only through its
dedicated command:

```bash
LITE_AGENT_COMPAT_BASE_URL=http://127.0.0.1:11434/v1 \
LITE_AGENT_COMPAT_MODEL=qwen3:8b \
pnpm --filter @lite-agent/provider test:compat
```

`LITE_AGENT_COMPAT_API_KEY` is optional and defaults to `local`.
`LITE_AGENT_COMPAT_FORCED_TOOL` accepts `true` or `false` (default `false`);
other non-empty values are rejected before client construction. Set it to
`true` to add a stronger profile that forces the named `echo` tool. Passing
that profile proves named forced-tool selection; it does not claim that every
native tool-choice mode is supported.

The adapters currently differ on malformed streamed tool JSON: Anthropic
surfaces a provider error, while OpenAI falls back to an empty input object and
lets downstream tool-schema validation reject it.
```

- [ ] **Step 3: Apply the matching Chinese correction and documentation**

Replace the final paragraph under `## 选项` in `packages/provider/README.zh-CN.md` with:

```markdown
包根部导出两个工厂及其选项/客户端类型（`AnthropicProviderOptions`、
`AnthropicClientLike`、`OpenAIProviderOptions`、`OpenAIClientLike`）。请求映射器和
流转换器属于适配器内部实现，不是包根部的公共导出。
```

Insert before the monorepo architecture link:

```markdown
## 支持等级

| 等级 | 含义 |
| --- | --- |
| 维护中的适配器 | 仓库负责请求映射和流转换，并通过离线共享合约测试。 |
| 维护中的预设 | 仓库基于维护中的适配器提供端点/配置预设；具体能力仍取决于运行时和模型。 |
| 兼容端点 | 用户提供、预期实现相同协议的端点；在探测其确切运行时/模型组合前仅为尽力兼容。 |

| 集成 | 等级 | 说明 |
| --- | --- | --- |
| Anthropic Messages | 维护中的适配器 | 离线覆盖文本流、工具调用、归一化 usage、取消传播和 `ProviderError`。 |
| OpenAI Chat Completions | 维护中的适配器 | 应用相同的离线共享合约。 |
| Ollama、vLLM、LM Studio、llama.cpp | [`@lite-agent/local`](../local) 中维护的预设 | 复用 OpenAI 兼容适配器；原生工具和 usage 能力取决于运行时及模型。 |
| 其他 OpenAI 兼容端点 | 兼容端点 | 默认未经验证；请对确切端点和模型运行下面的探测。 |

“兼容”不是对所有实现的笼统认证。不同服务在流式输出、`stream_options`、
工具选择、usage 和错误行为上可能不同。

## 探测 OpenAI 兼容端点

该探测被明确排除在普通测试之外，只能通过专用命令运行：

```bash
LITE_AGENT_COMPAT_BASE_URL=http://127.0.0.1:11434/v1 \
LITE_AGENT_COMPAT_MODEL=qwen3:8b \
pnpm --filter @lite-agent/provider test:compat
```

`LITE_AGENT_COMPAT_API_KEY` 可选，默认值为 `local`。
`LITE_AGENT_COMPAT_FORCED_TOOL` 只接受 `true` 或 `false`（默认 `false`）；其他
非空值会在创建客户端前被拒绝。设置为 `true` 会增加一个强制调用具名 `echo`
工具的更强探测。通过该探测只证明具名强制工具选择可用，不代表所有原生工具选择
模式都可用。

两个适配器目前对流式工具 JSON 损坏的处理不同：Anthropic 会抛出 provider
错误；OpenAI 会退化为空输入对象，再由下游工具 schema 校验拒绝。
```

- [ ] **Step 4: Verify the two documents contain matching claims**

Run:

```bash
rg -n "Maintained adapter|Compatible endpoint|LITE_AGENT_COMPAT_FORCED_TOOL|internal adapter" packages/provider/README.md
rg -n "维护中的适配器|兼容端点|LITE_AGENT_COMPAT_FORCED_TOOL|适配器内部" packages/provider/README.zh-CN.md
rg -n "plus the low-level|并在你需要时提供底层" packages/provider/README.md packages/provider/README.zh-CN.md
```

Expected: the first two commands find the new matrix, probe flag, and corrected API statement; the third command returns no matches.

- [ ] **Step 5: Run the safe full repository verification**

Run in this exact order:

```bash
pnpm -r build
pnpm -r test
pnpm -r typecheck
```

Expected: every workspace package builds; all offline tests pass; every package typechecks. The compatibility smoke file is absent from default test output and no network request occurs.

- [ ] **Step 6: Review scope and diff quality**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; only the files listed in this plan are modified; no provider production file, normalized model type, dependency, version, or changelog changed.

- [ ] **Step 7: Commit documentation**

```bash
git add packages/provider/README.md packages/provider/README.zh-CN.md
git commit -m "docs(provider): document compatibility support levels"
```

## Completion criteria

- `providerConformance` is a small flat public case array with exactly the semantic scenarios required by the approved design.
- Both maintained adapters pass the same six offline cases through their existing injected clients.
- Existing provider-specific mapping and stream tests continue to pass unchanged.
- The compatibility probe is reachable only through `test:compat`; missing configuration fails before client construction.
- Default workspace verification performs no network access.
- English and Chinese documentation agree and make no blanket compatibility or public-export claim.
- The implementation contains no speculative provider framework or unrelated refactor.
