import type {
  AssistantMessage, Message, StopReason, ToolCall, ToolResult, Usage, UserAnswer, UserQuestion,
} from "./types";
import type { BackgroundCompletion } from "./background";

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
  | { type: "diagnostic"; level: "info" | "warning" | "error"; code: string; message: string }
  | { type: "model_call_start"; turn: number; model: string }
  | { type: "model_call_end"; turn: number; model: string; durationMs: number; usage?: Usage; error?: string }
  | { type: "text_delta"; text: string }
  | { type: "message"; message: AssistantMessage }
  | { type: "tool_use"; call: ToolCall }
  | { type: "tool_call_start"; call: ToolCall; turn: number }
  | { type: "tool_call_end"; id: string; name: string; turn: number; durationMs: number; isError: boolean }
  | { type: "tool_recovered"; id: string; name: string; turn: number }
  | { type: "approval_request"; call: ToolCall; reason?: string }
  | { type: "approval_resolved"; id: string; decision: "allow" | "deny"; by: string }
  | { type: "permission_decision"; call: ToolCall; decision: "allow" | "deny" | "ask"; ruleId?: string; reason?: string; simulated?: boolean; by: "policy" | "user" | "auto" }
  | { type: "input_request"; call: ToolCall; question: UserQuestion }
  | { type: "input_resolved"; id: string; answer: UserAnswer }
  | { type: "tool_result"; result: ToolResult }
  | { type: "compaction"; kind: "micro" | "auto" | "manual"; before: number; after: number; phase?: "start" | "done" }
  | { type: "steer"; messages: Message[] }
  | { type: "background_completed"; completion: BackgroundCompletion }
  | { type: "turn_end"; turn: number; stopReason: StopReason }
  | { type: "error"; error: AgentError; fatal: boolean }
  | { type: "done"; reason: "stop" | "aborted" | "max_turns"; result: RunResult };

/** `agentId` is set on events forwarded from a subagent; undefined for the main agent. */
export type AgentEvent = { agentId?: string } & AgentEventBody;
