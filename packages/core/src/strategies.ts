import type { ZodType } from "zod";
import type {
  AssistantMessage, Message, ModelChunk, ModelRequest, ToolCall, ToolResult, ToolSpec,
  Usage, UserAnswer, UserQuestion,
} from "./types";
import type { AgentEvent } from "./events";
import type { BackgroundTasks } from "./background";

export interface ModelProvider {
  readonly id: string;
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelChunk>;
}

export interface ToolCallCodec {
  /** Prompt codecs buffer protocol text until it has been decoded. */
  readonly streaming?: "passthrough" | "buffer";
  encode(req: ModelRequest, tools: ToolSpec[]): ModelRequest;
  decode(message: AssistantMessage): { text: string; calls: ToolCall[] };
  repairPrompt?(error: Error, attempt: number, tools: ToolSpec[]): Message;
}

// Slim context handed to Tool.execute. Approval/Input are wired in Phase 3.
export interface ToolContext {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  emit(ev: AgentEvent): void;
  readonly approval?: ApprovalHandler;
  readonly input?: InputHandler;
  readonly sandbox?: Sandbox;
  readonly background?: BackgroundTasks;
  readonly call?: ToolCall;
  /** Record a file's pre-mutation content into the session log (for restore). Provided by
   *  the kernel only when a checkpointer is active; file-mutating tools call it before writing. */
  recordSnapshot?(
    path: string,
    before: string | null,
    truncated?: boolean,
    encoding?: "utf8" | "base64",
  ): void | Promise<void>;
}

export interface ToolSecurity {
  /** Network reachability used by strict/offline assemblers. */
  network: "none" | "loopback" | "private" | "unrestricted";
  filesystem?: "none" | "workspace" | "unrestricted";
  sideEffects?: "none" | "workspace" | "external";
}

export interface Tool<I = unknown> {
  name: string;
  description: string;
  schema: ZodType<I>;
  security?: ToolSecurity;
  execute(input: I, ctx: ToolContext): Promise<string> | string;
}

export type TokenEstimator = (messages: Message[]) => number | Promise<number>;

// --- Strategies implemented in later phases; declared here so types are stable. ---
export type CompactResult = {
  messages: Message[];
  kind?: "micro" | "auto";
  before?: number;
  after?: number;
};
export interface Compactor {
  /** `instructions` is free-text steering for a manual compaction (Claude Code's `/compact <instructions>`):
   *  appended to the summary prompt to bias what's preserved. Omitted for automatic/proactive compaction.
   *  Structural compactors ignore it; only LLM-summary compactors act on it. */
  maybeCompact(messages: Message[], usage: Usage, instructions?: string): Promise<CompactResult>;
}

export type Decision = "allow" | "deny" | "ask";
// Narrower than ToolContext on purpose: a permission policy gets identity only — no emit/signal.
export interface PolicyContext { readonly sessionId: string; }
/** A decision plus optional provenance (which rule, why) for audit + denied messages. */
export interface PolicyVerdict { decision: Decision; ruleId?: string; reason?: string; }
export interface PermissionPolicy {
  check(call: ToolCall, ctx: PolicyContext): Decision | PolicyVerdict | Promise<Decision | PolicyVerdict>;
}

export interface ApprovalHandler { request(call: ToolCall): Promise<"allow" | "deny">; }
export interface InputHandler { request(q: UserQuestion): Promise<UserAnswer>; }

export interface SandboxWrapOptions {
  readonly cwd: string;
}

// 9th strategy — wraps a shell command so it runs inside an OS-level boundary.
export interface Sandbox {
  readonly id: string;
  wrap(command: string, opts: SandboxWrapOptions): Promise<string> | string;
  initialize?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export interface Store {
  load(id: string): Promise<Message[] | null>;
  save(id: string, messages: Message[]): Promise<void>;
}
