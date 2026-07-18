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
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;

  for await (const event of events) {
    switch (event.type) {
      case "message_start":
        inputTokens = event.message.usage.input_tokens;
        if (typeof event.message.usage.cache_read_input_tokens === "number") {
          cacheReadTokens = event.message.usage.cache_read_input_tokens;
        }
        if (typeof event.message.usage.cache_creation_input_tokens === "number") {
          cacheCreationTokens = event.message.usage.cache_creation_input_tokens;
        }
        break;
      case "content_block_start": {
        const cb = event.content_block as unknown as { type: string; [key: string]: unknown };
        if (cb.type === "text") {
          blocks[event.index] = { type: "text", text: String(cb.text ?? "") };
        } else if (cb.type === "tool_use") {
          blocks[event.index] = {
            type: "tool_call",
            id: String(cb.id ?? ""),
            name: String(cb.name ?? ""),
            input: {},
          };
          toolJson[event.index] = "";
        } else if (cb.type === "compaction") {
          blocks[event.index] = { type: "compaction", content: typeof cb.content === "string" ? cb.content : null };
        } else {
          blocks[event.index] = { type: "native", provider: "anthropic", data: cb };
        }
        break;
      }
      case "content_block_delta": {
        const d = event.delta as unknown as { type: string; [key: string]: unknown };
        if (d.type === "text_delta") {
          const b = blocks[event.index];
          const text = String(d.text ?? "");
          if (b && b.type === "text") b.text += text;
          yield { type: "text_delta", text };
        } else if (d.type === "input_json_delta") {
          toolJson[event.index] =
            (toolJson[event.index] ?? "") + String(d.partial_json ?? "");
        } else if (d.type === "compaction_delta") {
          const b = blocks[event.index];
          if (b && b.type === "compaction" && typeof d.content === "string") {
            b.content = (b.content ?? "") + d.content;
          }
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
        if (typeof event.usage.cache_read_input_tokens === "number") {
          cacheReadTokens = event.usage.cache_read_input_tokens;
        }
        if (typeof event.usage.cache_creation_input_tokens === "number") {
          cacheCreationTokens = event.usage.cache_creation_input_tokens;
        }
        break;
      case "message_stop": {
        const message: AssistantMessage = {
          role: "assistant",
          content: blocks.filter((b): b is ContentBlock => b !== undefined),
        };
        const usage: Usage = {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
          ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
        };
        yield { type: "message_done", message, usage };
        break;
      }
    }
  }
}
