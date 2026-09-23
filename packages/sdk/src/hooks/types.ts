import type { Message, RunResult, ToolCall, ToolResult } from "@lite-agent/core";

export const HOOK_NAMES = ["run:start", "run:end", "tool:start", "tool:end", "compact:start", "compact:end"] as const;
export type HookName = typeof HOOK_NAMES[number];
export type HookStatus = "completed" | "failed" | "cancelled" | "max_turns";
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

interface Identity {
  readonly runId: string;
  readonly sessionId: string;
  /** Absent for the root; stable child identity otherwise. */
  readonly agentId?: string;
  readonly source: "user" | "background" | "manual";
}

type End = { status: HookStatus; error?: { name: string; message: string } };
type Compact = { compactionId: string; kind: "micro" | "auto" | "manual"; before: number };
type Data = {
  "run:start": { input: string | Message[] };
  "run:end": End & { result?: Omit<RunResult, "messages"> & { output?: unknown } };
  "tool:start": { call: ToolCall };
  "tool:end": End & { call: ToolCall; result?: ToolResult; durationMs: number };
  "compact:start": Compact & { instructions?: string };
  "compact:end": Compact & End & { after: number };
};

export type HookEventMap = { [N in HookName]: Immutable<Identity & Data[N]> & { readonly event: N } };
export type HookEvent = HookEventMap[HookName];
export type HookHandler<N extends HookName> = (event: HookEventMap[N], context: { readonly signal: AbortSignal }) => void | Promise<void>;
export interface HookOptions { timeoutMs?: number; }

export interface CommandHook {
  event: HookName;
  command: string;
  timeoutMs: number;
  /** Tool name glob; allowed only for tool events. */
  match?: string;
  source: "global" | "project";
  file: string;
}
