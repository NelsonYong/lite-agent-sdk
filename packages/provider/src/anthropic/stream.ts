import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage, ContentBlock, ModelChunk, Usage } from "@lite-agent-sdk/core";

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
          blocks[event.index] = { type: "tool_call", id: cb.id, name: cb.name, input: {} };
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
          toolJson[event.index] = (toolJson[event.index] ?? "") + d.partial_json;
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
