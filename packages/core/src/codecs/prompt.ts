import { createHash } from "node:crypto";
import type { AssistantMessage, Message, ToolCall, ToolSpec } from "../types";

export function messageText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function deterministicCallId(protocol: string, index: number, name: string, input: unknown): string {
  const hash = createHash("sha256")
    .update(protocol)
    .update("\0")
    .update(String(index))
    .update("\0")
    .update(name)
    .update("\0")
    .update(JSON.stringify(input ?? {}))
    .digest("hex")
    .slice(0, 16);
  return `call_${hash}`;
}

export function extractJson(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced?.startsWith("{")) return fenced;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  return trimmed;
}

export function promptMessages(
  messages: Message[],
  renderAssistantCalls: (calls: ToolCall[]) => string,
  renderToolResults: (results: Array<{ id: string; content: string; isError: boolean }>) => string,
): Message[] {
  return messages.map((message): Message => {
    if (typeof message.content === "string") return message;
    if (message.role === "assistant") {
      const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = message.content
        .filter((b) => b.type === "tool_call")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      return { role: "assistant", content: calls.length ? renderAssistantCalls(calls) : text };
    }
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const results = message.content
      .filter((b) => b.type === "tool_result")
      .map((b) => ({ id: b.id, content: b.content, isError: b.isError === true }));
    const rendered = results.length ? renderToolResults(results) : "";
    return { role: "user", content: [text, rendered].filter(Boolean).join("\n") };
  });
}

export function toolCatalog(tools: ToolSpec[]): string {
  return JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })));
}
