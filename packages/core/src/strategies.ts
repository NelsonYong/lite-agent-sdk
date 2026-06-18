import type { ZodType } from "zod";
import type {
  AssistantMessage, Message, ModelChunk, ModelRequest, ToolCall, ToolResult, ToolSpec,
  Usage, UserAnswer, UserQuestion,
} from "./types";
import type { AgentEvent } from "./events";

export interface ModelProvider {
  readonly id: string;
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelChunk>;
}

export interface ToolCallCodec {
  encode(req: ModelRequest, tools: ToolSpec[]): ModelRequest;
  decode(message: AssistantMessage): { text: string; calls: ToolCall[] };
}

// Slim context handed to Tool.execute. Approval/Input are wired in Phase 3.
export interface ToolContext {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  emit(ev: AgentEvent): void;
  readonly approval?: ApprovalHandler;
  readonly input?: InputHandler;
}

export interface Tool<I = unknown> {
  name: string;
  description: string;
  schema: ZodType<I>;
  execute(input: I, ctx: ToolContext): Promise<string> | string;
}

// --- Strategies implemented in later phases; declared here so types are stable. ---
export type CompactResult = {
  messages: Message[]; kind?: "micro" | "auto"; before?: number; after?: number;
};
export interface Compactor {
  maybeCompact(messages: Message[], usage: Usage): Promise<CompactResult>;
}

export type Decision = "allow" | "deny" | "ask";
export interface PolicyContext { readonly sessionId: string; }
export interface PermissionPolicy {
  check(call: ToolCall, ctx: PolicyContext): Decision | Promise<Decision>;
}

export interface ApprovalHandler { request(call: ToolCall): Promise<"allow" | "deny">; }
export interface InputHandler { request(q: UserQuestion): Promise<UserAnswer>; }

export interface Store {
  load(id: string): Promise<Message[] | null>;
  save(id: string, messages: Message[]): Promise<void>;
}
