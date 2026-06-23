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
