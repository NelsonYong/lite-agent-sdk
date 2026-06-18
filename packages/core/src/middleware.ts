import type { Message, ModelChunk, ToolCall, ToolResult } from "./types";
import type { AgentEvent } from "./events";

export interface AgentContext {
  readonly sessionId: string;
  messages: Message[];
  readonly turn: number;
  readonly signal: AbortSignal;
  emit(ev: AgentEvent): void;
  state: Map<string, unknown>;
}
export interface ToolCallContext extends AgentContext { readonly call: ToolCall; }

export type ModelCall = () => AsyncIterable<ModelChunk>;
export type ToolExec = () => Promise<ToolResult>;
export type LifecycleHook = "beforeAgent" | "afterAgent" | "beforeModel";

export interface Middleware {
  name: string;
  beforeAgent?(ctx: AgentContext): void | Promise<void>;
  afterAgent?(ctx: AgentContext): void | Promise<void>;
  beforeModel?(ctx: AgentContext): void | Promise<void>;
  wrapModelCall?(ctx: AgentContext, next: ModelCall): AsyncIterable<ModelChunk>;
  wrapToolCall?(ctx: ToolCallContext, next: ToolExec): Promise<ToolResult>;
}

export function composeModelCall(mws: Middleware[], ctx: AgentContext, base: ModelCall): ModelCall {
  return mws
    .filter((m) => m.wrapModelCall)
    .reduceRight<ModelCall>((next, m) => () => m.wrapModelCall!(ctx, next), base);
}

export function composeToolCall(mws: Middleware[], ctx: ToolCallContext, base: ToolExec): ToolExec {
  return mws
    .filter((m) => m.wrapToolCall)
    .reduceRight<ToolExec>((next, m) => () => m.wrapToolCall!(ctx, next), base);
}

export async function runLifecycle(mws: Middleware[], hook: LifecycleHook, ctx: AgentContext): Promise<void> {
  for (const m of mws) {
    const fn = m[hook];
    if (fn) await fn.call(m, ctx);
  }
}
