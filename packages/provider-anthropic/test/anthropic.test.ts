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
          yield { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } };
          yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
          yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } };
          yield { type: "content_block_stop", index: 0 };
          yield { type: "message_delta", delta: {}, usage: { output_tokens: 1 } };
          yield { type: "message_stop" };
        }
        return gen() as unknown as AsyncIterable<Anthropic.RawMessageStreamEvent>;
      },
    },
  };

  const provider = anthropic({ client: fakeClient });
  expect(provider.id).toBe("anthropic");

  const chunks: ModelChunk[] = [];
  for await (const c of provider.stream({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
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
