import { expect, test } from "vitest";
import { memoryCheckpointer } from "../src/checkpoint";
import { ProviderError, type AgentEvent, type RunResult } from "../src/events";
import { runKernel, type KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { retry } from "../src/retry";
import { noopSandbox } from "../src/sandbox";
import { textBlock, type ModelRequest } from "../src/types";
import type { ModelProvider } from "../src/strategies";

const signal = () => new AbortController().signal;

function config(provider: ModelProvider, over: Partial<KernelConfig> = {}): KernelConfig {
  return {
    provider,
    codec: nativeCodec(),
    tools: [],
    middleware: [],
    model: "model",
    system: "stable system",
    maxTurns: 4,
    sandbox: noopSandbox(),
    ...over,
  };
}

async function collect(gen: AsyncGenerator<AgentEvent, RunResult>) {
  const events: AgentEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

test("automatic context recovery retries one pre-stream overflow and commits a view", async () => {
  const cp = memoryCheckpointer();
  let calls = 0;
  const provider: ModelProvider = {
    id: "overflow",
    async *stream() {
      calls++;
      if (calls === 1) throw new ProviderError("prompt_too_long", 413);
      yield {
        type: "message_done",
        message: { role: "assistant", content: [textBlock("recovered")] },
        usage: { inputTokens: 4, outputTokens: 1 },
      };
    },
  };

  const { events } = await collect(runKernel(
    config(provider, { checkpointer: cp, context: { windowTokens: 64 } }),
    "old context ".repeat(1000),
    signal(),
    "overflow-session",
  ));

  expect(calls).toBe(2);
  expect(events).toContainEqual(expect.objectContaining({ type: "context_status", level: 5 }));
  const stored = [];
  for await (const entry of cp.read("overflow-session")) stored.push(entry.event.type);
  expect(stored).toContain("context_view");
});

test("system and tools stay byte-stable across a normal tool loop", async () => {
  const staticPrefixes: string[] = [];
  let turn = 0;
  const provider: ModelProvider = {
    id: "capture",
    async *stream(req: ModelRequest) {
      staticPrefixes.push(JSON.stringify({ system: req.system, tools: req.tools }));
      if (turn++ === 0) {
        yield {
          type: "message_done",
          message: {
            role: "assistant",
            content: [{ type: "tool_call", id: "missing-1", name: "missing", input: {} }],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      } else {
        yield {
          type: "message_done",
          message: { role: "assistant", content: [textBlock("done")] },
          usage: { inputTokens: 2, outputTokens: 1 },
        };
      }
    },
  };

  await collect(runKernel(config(provider), "go", signal(), "prefix-session"));

  expect(staticPrefixes).toHaveLength(2);
  expect(staticPrefixes[1]).toBe(staticPrefixes[0]);
});

test("context false leaves overflow handling to the caller", async () => {
  let calls = 0;
  const provider: ModelProvider = {
    id: "overflow-off",
    async *stream() {
      calls++;
      throw new ProviderError("prompt_too_long", 413);
    },
  };

  await expect(collect(runKernel(
    config(provider, { context: false }),
    "large request",
    signal(),
    "off-session",
  ))).rejects.toThrow("prompt_too_long");
  expect(calls).toBe(1);
});

test("provider-native context edits are prepared once per retry request", async () => {
  let calls = 0;
  let clearToolUses = 0;
  let clearThinking = 0;
  let compact = 0;
  const provider: ModelProvider = {
    id: "native-edits",
    context: {
      clearToolUses: (req) => { clearToolUses++; return req; },
      clearThinking: (req) => { clearThinking++; return req; },
      compact: (req) => { compact++; return req; },
    },
    async *stream() {
      calls++;
      if (calls === 1) throw new ProviderError("temporary", 503);
      yield {
        type: "message_done",
        message: { role: "assistant", content: [textBlock("ok")] },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  await collect(runKernel(
    config(provider, { context: { windowTokens: 1 }, middleware: [retry({ backoff: () => 0 })] }),
    "large ".repeat(100),
    signal(),
    "native-edits-session",
  ));

  expect(calls).toBe(2);
  expect(clearToolUses).toBe(2);
  expect(clearThinking).toBe(2);
  expect(compact).toBe(2);
});

test("native compaction blocks remain typed in the checkpoint transcript", async () => {
  const cp = memoryCheckpointer();
  const provider: ModelProvider = {
    id: "native-block",
    async *stream() {
      yield {
        type: "message_done",
        message: { role: "assistant", content: [{ type: "compaction", content: "server summary" }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  await collect(runKernel(
    config(provider, { checkpointer: cp, context: false }),
    "go",
    signal(),
    "native-block-session",
  ));

  const assistant = [];
  for await (const entry of cp.read("native-block-session")) {
    if (entry.event.type === "assistant") assistant.push(entry.event.message);
  }
  expect(assistant.at(-1)).toEqual({
    role: "assistant",
    content: [{ type: "compaction", content: "server summary" }],
  });
});
