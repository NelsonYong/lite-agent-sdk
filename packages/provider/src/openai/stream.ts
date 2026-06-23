import type OpenAI from "openai";
import type {
  AssistantMessage,
  ContentBlock,
  ModelChunk,
  Usage,
} from "@lite-agent/core";
import { textBlock } from "@lite-agent/core";

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;

function safeParse(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

export async function* translateStream(
  raw: AsyncIterable<Chunk>,
): AsyncIterable<ModelChunk> {
  let text = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };

  for await (const chunk of raw) {
    const delta = chunk.choices[0]?.delta;
    if (delta?.content) {
      text += delta.content;
      yield { type: "text_delta", text: delta.content };
    }
    for (const tc of delta?.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(tc.index, cur);
    }
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      };
    }
  }

  const content: ContentBlock[] = [];
  if (text) content.push(textBlock(text));
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    content.push({
      type: "tool_call",
      id: c.id,
      name: c.name,
      input: safeParse(c.args),
    });
  }
  const message: AssistantMessage = { role: "assistant", content };
  yield { type: "message_done", message, usage };
}
