export { createAgent } from "./createAgent";
export type { Agent, CreateAgentConfig, RunOptions } from "./createAgent";

export { nativeCodec } from "./codecs/native";
export { defineTool, toToolSpec } from "./tools/define";
export { fakeProvider } from "./testing/fakeProvider";
export type { FakeTurn } from "./testing/fakeProvider";

export { composeModelCall, composeToolCall, runLifecycle } from "./middleware";
export type { AgentContext, ToolCallContext, Middleware, ModelCall, ToolExec } from "./middleware";

export type {
  ModelProvider, ToolCallCodec, Tool, ToolContext,
  Compactor, CompactResult, PermissionPolicy, PolicyContext, Decision,
  ApprovalHandler, InputHandler, Store,
} from "./strategies";

export type { AgentEvent, RunResult } from "./events";
export {
  AgentError, ProviderError, ToolError, CodecError, MaxTurnsError, AbortError,
} from "./events";

export * from "./types";
