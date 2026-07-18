import type Anthropic from "@anthropic-ai/sdk";
import type { ModelRequest } from "@lite-agent/core";
import { expect, test } from "vitest";
import { anthropic } from "../src/anthropic";
import type { AnthropicClientLike } from "../src/anthropic";

async function* emptyStream(): AsyncIterable<Anthropic.RawMessageStreamEvent> {}

const request: ModelRequest = {
  model: "claude-test",
  system: "stable system",
  messages: [{ role: "user", content: "hello" }],
  maxTokens: 123,
  tools: [
    {
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: {} },
    },
  ],
};

test("advertises automatic prompt caching without requiring token counting", () => {
  const client: AnthropicClientLike = {
    messages: { create: () => emptyStream() },
  };

  const provider = anthropic({ client });

  expect(provider.context).toEqual({
    promptCache: { mode: "automatic" },
  });
});

test("uses Anthropic beta context edits without changing the normalized request", async () => {
  let captured: Record<string, unknown> | undefined;
  const client: AnthropicClientLike = {
    messages: { create: () => emptyStream() },
    beta: {
      messages: {
        create(params) {
          captured = params as Record<string, unknown>;
          return emptyStream();
        },
      },
    },
  };
  const provider = anthropic({ client });
  const edit = provider.context?.clearToolUses;
  expect(edit).toBeDefined();
  const edited = await edit!(request);
  expect(edited).toBe(request);

  for await (const _ of provider.stream(edited)) { /* drain */ }

  expect(captured).toMatchObject({
    betas: ["context-management-2025-06-27"],
    system: [{ type: "text", text: "stable system", cache_control: { type: "ephemeral" } }],
    context_management: {
      edits: [{ type: "clear_tool_uses_20250919" }],
    },
  });
});

test("maps clear-thinking and compact edits together and keeps the native compaction block", async () => {
  let captured: Record<string, unknown> | undefined;
  const client: AnthropicClientLike = {
    messages: { create: () => emptyStream() },
    beta: {
      messages: {
        create(params) {
          captured = params as Record<string, unknown>;
          return (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 1 } } } as never;
            yield { type: "content_block_start", index: 0, content_block: { type: "compaction", content: null } } as never;
            yield { type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: "keep this" } } as never;
            yield { type: "content_block_stop", index: 0 } as never;
            yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } as never;
            yield { type: "message_stop" } as never;
          })();
        },
      },
    },
  };
  const provider = anthropic({ client });
  const req = await provider.context?.clearThinking?.(request);
  const compacted = await provider.context?.compact?.(req!);
  const chunks = [];
  for await (const chunk of provider.stream(compacted!)) chunks.push(chunk);

  expect(captured).toMatchObject({
    betas: ["context-management-2025-06-27"],
    system: [{ type: "text", text: "stable system", cache_control: { type: "ephemeral" } }],
    context_management: {
      edits: [
        { type: "clear_thinking_20251015" },
        { type: "compact_20260112" },
      ],
    },
  });
  expect(chunks.at(-1)).toMatchObject({
    type: "message_done",
    message: { content: [{ type: "compaction", content: "keep this" }] },
  });
});

test("counts the mapped Anthropic request without generation-only fields", async () => {
  let captured: Anthropic.MessageCountTokensParams | undefined;
  let capturedSignal: AbortSignal | undefined;
  const client: AnthropicClientLike = {
    messages: {
      create: () => emptyStream(),
      async countTokens(params, options) {
        captured = params;
        capturedSignal = options?.signal;
        return { input_tokens: 42 };
      },
    },
  };
  const provider = anthropic({ client });
  const controller = new AbortController();

  const count = await provider.context?.countTokens?.(
    request,
    controller.signal,
  );

  expect(count).toBe(42);
  expect(capturedSignal).toBe(controller.signal);
  expect(captured).toMatchObject({
    model: "claude-test",
    system: [{ type: "text", text: "stable system", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "lookup",
        description: "Look something up",
        input_schema: { type: "object", properties: {} },
      },
    ],
  });
  expect(captured).not.toHaveProperty("stream");
  expect(captured).not.toHaveProperty("max_tokens");
});
