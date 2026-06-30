import type {
  AssistantMessage, Message, StopReason, ToolCall, ToolResult, Usage, UserAnswer, UserQuestion,
} from "./types";

export type RunResult = {
  messages: Message[];
  text: string;
  usage: Usage;
  stopReason: "stop" | "aborted" | "max_turns";
};

export class AgentError extends Error {}
export class ProviderError extends AgentError {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}
export class ToolError extends AgentError {
  constructor(message: string) { super(message); this.name = "ToolError"; }
}
export class CodecError extends AgentError {
  constructor(message: string) { super(message); this.name = "CodecError"; }
}
export class MaxTurnsError extends AgentError {
  constructor(message: string) { super(message); this.name = "MaxTurnsError"; }
}
export class AbortError extends AgentError {
  constructor(message = "aborted") { super(message); this.name = "AbortError"; }
}
export class CheckpointConflictError extends AgentError {
  constructor(readonly sessionId: string, readonly expected: number, readonly actual: number) {
    super(`checkpoint conflict on '${sessionId}': expected head ${expected}, found ${actual}`);
    this.name = "CheckpointConflictError";
  }
}

type AgentEventBody =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "message"; message: AssistantMessage }
  | { type: "tool_use"; call: ToolCall }
  | { type: "approval_request"; call: ToolCall; reason?: string }
  | { type: "approval_resolved"; id: string; decision: "allow" | "deny"; by: string }
  | { type: "input_request"; call: ToolCall; question: UserQuestion }
  | { type: "input_resolved"; id: string; answer: UserAnswer }
  | { type: "tool_result"; result: ToolResult }
  | { type: "compaction"; kind: "micro" | "auto"; before: number; after: number }
  | { type: "turn_end"; turn: number; stopReason: StopReason }
  | { type: "error"; error: AgentError; fatal: boolean }
  | { type: "done"; reason: "stop" | "aborted" | "max_turns"; result: RunResult };

/** `agentId` is set on events forwarded from a subagent; undefined for the main agent. */
export type AgentEvent = { agentId?: string } & AgentEventBody;
