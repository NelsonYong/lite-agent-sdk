import type OpenAI from "openai";
import type {
  ContentBlock,
  Message,
  ModelRequest,
  ToolChoice,
  ToolSpec,
} from "@lite-agent/core";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text)
    .join("");
}

function toChatMessages(m: Message): ChatMessage[] {
  if (typeof m.content === "string") {
    if (m.role === "assistant")
      return [{ role: "assistant", content: m.content }];
    return [{ role: "user", content: m.content }];
  }
  if (m.role === "assistant") {
    const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: textOf(m.content) || null,
    };
    const toolCalls = m.content
      .filter(
        (b): b is Extract<ContentBlock, { type: "tool_call" }> =>
          b.type === "tool_call",
      )
      .map(
        (b): OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }),
      );
    if (toolCalls.length) msg.tool_calls = toolCalls;
    return [msg];
  }
  const out: ChatMessage[] = [];
  const texts: string[] = [];
  for (const b of m.content) {
    if (b.type === "tool_result")
      out.push({ role: "tool", tool_call_id: b.id, content: b.content });
    else if (b.type === "text") texts.push(b.text);
  }
  if (texts.length) out.push({ role: "user", content: texts.join("") });
  return out;
}

function toChatTool(
  spec: ToolSpec,
): OpenAI.Chat.Completions.ChatCompletionFunctionTool {
  const { $schema: _drop, ...parameters } = spec.parameters;
  return {
    type: "function",
    function: { name: spec.name, description: spec.description, parameters },
  };
}

export function toOpenAIParams(
  req: ModelRequest,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  const messages: ChatMessage[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "system") continue;
    messages.push(...toChatMessages(m));
  }
  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.maxTokens) params.max_tokens = req.maxTokens;
  if (req.stopSequences) params.stop = req.stopSequences;
  if (req.temperature !== undefined) params.temperature = req.temperature;
  if (req.topP !== undefined) params.top_p = req.topP;
  if (req.seed !== undefined) params.seed = req.seed;
  if (req.tools && req.tools.length) {
    params.tools = req.tools.map(toChatTool);
    // tool_choice is only valid alongside tools; omit it otherwise (OpenAI 400s).
    if (req.toolChoice !== undefined) params.tool_choice = toOpenAIToolChoice(req.toolChoice);
  }
  return params;
}

function toOpenAIToolChoice(
  tc: ToolChoice,
): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption {
  if (tc === "auto" || tc === "none" || tc === "required") return tc;
  return { type: "function", function: { name: tc.tool } };
}
