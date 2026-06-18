export type Role = "system" | "user" | "assistant" | "tool";

export type TextBlock = { type: "text"; text: string };
export type ToolCallBlock = { type: "tool_call"; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: "tool_result"; id: string; content: string; isError?: boolean };
export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export type Message = { role: Role; content: string | ContentBlock[] };
export type AssistantMessage = { role: "assistant"; content: ContentBlock[] };

export type ToolCall = { id: string; name: string; input: unknown };
export type ToolResult = { id: string; name: string; content: string; isError?: boolean };

export type Usage = { inputTokens: number; outputTokens: number };
export type StopReason = "stop" | "tool_use" | "max_tokens";

export type UserQuestion = { question: string; options?: string[]; multiSelect?: boolean };
export type UserAnswer = { text?: string; selected?: string[] };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type ModelRequest = {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens?: number;
  stopSequences?: string[];
};

export type ModelChunk =
  | { type: "text_delta"; text: string }
  | { type: "message_done"; message: AssistantMessage; usage: Usage };

export const textBlock = (text: string): TextBlock => ({ type: "text", text });

export const toolResultBlock = (id: string, content: string, isError = false): ToolResultBlock =>
  isError ? { type: "tool_result", id, content, isError: true } : { type: "tool_result", id, content };

export const isToolCallBlock = (b: ContentBlock): b is ToolCallBlock => b.type === "tool_call";
export const isTextBlock = (b: ContentBlock): b is TextBlock => b.type === "text";
