import type { LanguageModelV4Message, LanguageModelV4Prompt, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { ContentBlock, ModelRequest } from "@lite-agent/core";
import { ProviderError } from "@lite-agent/core";

type AssistantPart = Extract<LanguageModelV4Message, { role: "assistant" }>["content"][number];
export type NativeData =
  | { kind: "part-options"; options: SharedV4ProviderOptions }
  | { kind: "reasoning"; part: Extract<AssistantPart, { type: "reasoning" }> }
  | { kind: "custom"; part: Extract<AssistantPart, { type: "custom" }> }
  | { kind: "source"; source: unknown }
  | { kind: "response-options"; options: SharedV4ProviderOptions };

export function nativeData(block: ContentBlock, provider: string): NativeData {
  if (block.type !== "native" || block.provider !== provider || !block.data || typeof block.data !== "object" || !("kind" in block.data))
    throw new ProviderError("Cannot replay native content from a different provider/model; start a new session or explicitly convert its history");
  return block.data as NativeData;
}

/** Keeps role boundaries and tool error status; opaque model state stays model-scoped. */
export function toAiPrompt(req: ModelRequest, provider: string): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [];
  const calls = new Map<string, string>();
  if (req.system) prompt.push({ role: "system", content: req.system });
  for (const message of req.messages) {
    if (typeof message.content === "string") {
      if (message.role === "tool") throw new ProviderError("A tool message requires a tool result with a matching call id");
      prompt.push(message.role === "system" ? { role: "system", content: message.content }
        : { role: message.role, content: [{ type: "text", text: message.content }] });
      continue;
    }
    if (message.role === "system") {
      if (message.content.some((block) => block.type !== "text")) throw new ProviderError("System messages only support text");
      prompt.push({ role: "system", content: message.content.map((block) => block.type === "text" ? block.text : "").join("") });
      continue;
    }
    if (message.role === "assistant") {
      const content: AssistantPart[] = [];
      let providerOptions: SharedV4ProviderOptions | undefined;
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "tool_call") {
          calls.set(block.id, block.name);
          content.push({ type: "tool-call", toolCallId: block.id, toolName: block.name, input: block.input });
        } else if (block.type === "native") {
          const data = nativeData(block, provider);
          switch (data.kind) {
            case "part-options": {
              const previous = content.at(-1);
              if (!previous) throw new ProviderError("Native part metadata has no preceding content");
              previous.providerOptions = data.options;
              break;
            }
            case "reasoning": case "custom": content.push(data.part); break;
            case "response-options": providerOptions = data.options; break;
            case "source": break; // Citations are retained for the host, not executable prompt parts.
            default: throw new ProviderError("Unsupported native assistant content");
          }
        } else throw new ProviderError(`Unsupported assistant block: ${block.type}`);
      }
      prompt.push({ role: "assistant", content, ...(providerOptions ? { providerOptions } : {}) });
      continue;
    }
    // A normalized user message can interleave tool results and user text.
    for (const block of message.content) {
      if (block.type === "text") {
        const previous = prompt.at(-1);
        if (previous?.role === "user") previous.content.push({ type: "text", text: block.text });
        else prompt.push({ role: "user", content: [{ type: "text", text: block.text }] });
      } else if (block.type === "tool_result") {
        const toolName = calls.get(block.id);
        if (!toolName) throw new ProviderError(`Tool result '${block.id}' has no matching tool call`);
        const result = { type: "tool-result" as const, toolCallId: block.id, toolName,
          output: { type: block.isError ? "error-text" as const : "text" as const, value: block.content } };
        const previous = prompt.at(-1);
        if (previous?.role === "tool") previous.content.push(result);
        else prompt.push({ role: "tool", content: [result] });
      } else throw new ProviderError(`Unsupported user/tool block: ${block.type}`);
    }
  }
  return prompt;
}
