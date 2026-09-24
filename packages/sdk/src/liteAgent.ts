import type { HookRuntime } from "./hooks/runtime";
import type { HookHandler, HookName, HookOptions } from "./hooks/types";
import { AgentError, estimateTokens, foldEvents, abortable, streamOperation } from "@lite-agent/core";
import type {
  Agent,
  AgentEvent,
  ApprovalHandler,
  BackgroundLimits,
  Checkpointer,
  Compactor,
  InputHandler,
  Message,
  Middleware,
  ModelProvider,
  PermissionPolicy,
  Redactor,
  RunOptions,
  RunResult,
  ReasoningEffort,
  Sandbox,
  Store,
  SessionEvent,
  Tool,
  ToolCallCodec,
  ToolChoice,
  TokenEstimator,
} from "@lite-agent/core";
import type { ContextPlannerProvider } from "@lite-agent/core";
import type { ZodType } from "zod";

import { checkpointEntries, checkpointList, restoreCheckpoint } from "./checkpoints";
import type { CheckpointInfo, RestoreResult } from "./checkpoints";
import type { FileToolsOptions } from "./tools/file";
import type { BashToolOptions } from "./tools/bash";
import { newSessionId } from "./store";
import type { SessionInfo } from "./store";
import type { LiteAgentEvent, SessionRunner } from "./sessionRunner";
import type { ModelConfiguration } from "./modelCatalog";
import type { McpApi, McpRegistry } from "./mcp/registry";
import type { McpServerConfig } from "./mcp/config";

export type { LiteAgentEvent } from "./sessionRunner";

export type ContextOptions = {
  planner?: ContextPlannerProvider;
  windowTokens?: number;
};

export interface CreateLiteAgentConfig extends ModelConfiguration {
  workdir: string;
  mcpServers?: Record<string, McpServerConfig>;
  /** Ignore global/project mcps.json; explicit definitions still apply. */
  strictMcpConfig?: boolean;
  /** Restrict transports, for example ['stdio'] for a sandboxed local host. */
  mcpTransports?: Array<"stdio" | "http">;
  skillsDir?: string;
  /** Load global and project hooks.json once at root creation. Default true. */
  hookFiles?: boolean;
  tools?: Tool[];
  /** Tool-call protocol. Default nativeCodec. */
  codec?: ToolCallCodec;
  system?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxTokens?: number;
  /** Sampling temperature, forwarded to the provider. Inherited by subagents. */
  temperature?: number;
  /** Nucleus sampling (top_p), forwarded to the provider. Inherited by subagents. */
  topP?: number;
  /** Tool-selection mode for the model. Inherited by subagents. */
  toolChoice?: ToolChoice;
  /** Reproducibility seed (OpenAI only; ignored by Anthropic). Inherited by subagents. */
  seed?: number;
  reasoningEffort?: ReasoningEffort;
  /**
   * Require a structured final answer. When set, a `final_answer` tool (whose
   * parameters are this schema) is registered and the model is instructed to call
   * it when done; the validated arguments surface as `result.output`. Must be an
   * object schema. Not inherited by subagents.
   */
  outputSchema?: ZodType;
  /** Max tool calls run concurrently per turn (default 10; 1 = sequential). Inherited by subagents. */
  maxParallelTools?: number;
  /** Max child kernels run concurrently across this root agent (default 5). */
  maxParallelSubagents?: number;
  /** Prompt-codec repair attempts after malformed output. Default 2. */
  maxDecodeRetries?: number;
  use?: Middleware[];
  sandbox?: Sandbox;
  /** Event-sourced persistence backend. Default: fileCheckpointer under the project's sessions dir. Overrides `store`. */
  checkpointer?: Checkpointer;
  store?: Store;
  /** Override the global home (default `$LITE_AGENT_HOME` || `~/.lite-agent`). */
  home?: string;
  /** Persist sessions to disk by default. False retains only in-memory conversation state. Ignored with an explicit checkpointer/store. */
  sessions?: boolean;
  /** @deprecated Use automatic `context` archive management. Kept as a one-release adapter. */
  spill?: boolean | { budgetBytes?: number };
  /** Persistent Tasks API (TaskCreate/Update/Get/List) + per-turn reminder. Default true. */
  tasks?: boolean;
  /** Explicit shared task-list id. Default `$LITE_AGENT_TASK_LIST_ID` or the current session id. */
  taskListId?: string;
  /** File-defined subagents + the `Agent` dispatch tool. Default true. */
  agents?: boolean;
  /** Extra agents dir, appended last so it overrides global + project. */
  agentsDir?: string;
  /** Additional child restrictions, composed with the inherited parent policy (deny wins). */
  subagentPermission?: PermissionPolicy;
  /** Non-blocking background tasks (bash run_in_background + background subagents) + the KillBackground tool. Default true. */
  background?: boolean;
  backgroundLimits?: BackgroundLimits;
  /** Default file-tool hardening and snapshot settings. */
  fileTools?: FileToolsOptions;
  /** Bash timeout, output, environment, and security metadata. */
  bash?: BashToolOptions;
  /** Safe mode persists tool starts and closes interrupted calls on resume. */
  crashRecovery?: "off" | "safe";
  /** Maximum retained snapshot bytes in one session. */
  maxSnapshotBytesPerSession?: number;
  /** Automatic context management. Omitted uses the SDK's ContextEngine defaults. */
  context?: false | ContextOptions;
  /** @deprecated Use `context`; explicitly supplying this selects the legacy adapter. */
  compactor?: Compactor | false;
  /** @deprecated Use `context.windowTokens`; explicitly supplying this selects the legacy adapter. */
  contextBudget?: { maxTokens: number; estimator?: TokenEstimator };
  /** Sweep stale spill/session files once at startup. Default true (30 days). */
  cleanup?: boolean | { maxAgeDays?: number; maxBytes?: number };
  /** Defaults to asking before shell/file mutations; no approval handler means deny. Custom tools are host-trusted. */
  permission?: PermissionPolicy;
  /** Redactor for permission audit payloads. Default: core `defaultRedactor`. */
  redact?: Redactor;
  /** Permission enforcement mode. "dry-run" records decisions without blocking. Default "enforce". */
  permissionMode?: "enforce" | "dry-run";
  /** Persist redacted permission decisions in the session event log. Default false. */
  permissionAudit?: boolean;
  onApproval?: ApprovalHandler;
  onAskUser?: InputHandler;
}

export type RuntimeLiteAgentConfig = Omit<CreateLiteAgentConfig, "model" | "modelName"> & {
  model: ModelProvider;
  modelName: string;
};

/** A run result, plus the validated structured answer when `outputSchema` is set. */
export type LiteAgentResult = RunResult & { output?: unknown };

export interface LiteAgent extends Agent {
  readonly mcp: McpApi;
  hook<N extends HookName>(name: N, handler: HookHandler<N>, opts?: HookOptions): () => void;
  run(input: string | Message[], opts?: RunOptions): AsyncGenerator<AgentEvent, LiteAgentResult>;
  send(input: string | Message[], opts?: RunOptions): Promise<LiteAgentResult>;
  /** Observe user runs and autonomous background-completion runs. */
  subscribe(listener: (entry: LiteAgentEvent) => void): () => void;
  /** Wait for this session's subagent groups and autonomous completion turns to settle. */
  awaitIdle(sessionId?: string): Promise<void>;
  /** Cancel live background work and close event delivery. Idempotent. */
  close(): Promise<void>;
  /** The session id `run`/`send` use when none is passed in `opts`. */
  readonly sessionId: string;
  /** Switch the current session to an existing id (lenient — unknown id starts empty). */
  resume(id: string): void;
  /** Rotate to a brand-new empty session; returns the new id. Does not delete the old transcript. */
  clear(): string;
  /** Delete a persisted session transcript. Requires a session-capable store. */
  deleteSession(id: string): Promise<void>;
  /** List persisted sessions (id + mtime, most-recent first). Requires a session-capable store. */
  listSessions(): Promise<SessionInfo[]>;
  /** List the rewind anchors (one per user prompt) for a session, oldest-first. Each entry's
   *  `seq` is the value to pass to `restore` to roll back to just BEFORE that prompt (so the
   *  prompt and everything after it are undone) — pass it straight through: `restore(id, cp.seq)`. */
  listCheckpoints(id: string): Promise<CheckpointInfo[]>;
  /** Roll a session back to the state right after event `toSeq`: revert files snapshotted after
   *  it (`files`) and/or truncate the conversation to it (`conversation`). Both default true.
   *  Sets the current session to `id`. Conversation rollback needs an event-sourced checkpointer
   *  with `truncate` (the default file/sqlite backends; a legacy `store` cannot). */
  restore(id: string, toSeq: number, opts?: { conversation?: boolean; files?: boolean; signal?: AbortSignal }): Promise<RestoreResult>;
  /** Manually compact the current session: compress the conversation, persist the result,
   *  emit progress + a completion notification, then stop. No model answer is produced.
   *  Optional `instructions` steer this compaction (Claude Code's `/compact <instructions>`) —
   *  passed to the compactor to bias what's preserved; only LLM-summary compactors act on it. */
  compact(instructions?: string, opts?: { signal?: AbortSignal }): AsyncGenerator<AgentEvent, { before: number; after: number }>;
}

/** Internal construction result. Not re-exported from createLiteAgent.ts or index.ts. */
export interface LiteAgentRuntime {
  refreshTools?(): void;
  readonly core: Agent;
  readonly checkpointer?: Checkpointer;
  readonly state: Checkpointer;
  dispose?(): Promise<void>;
  removeSession?(sessionId: string): void;
  /** The effective composed compactor shared with manual compact(). */
  readonly compactor?: Compactor;
  /** Present only with outputSchema; returns and removes one session's capture. */
  readonly takeOutput?: (sessionId: string) => unknown;
  /** Internal context control shared by automatic and manual compaction. */
  readonly context?: {
    measure(sessionId: string): Promise<number>;
    compact(sessionId: string, instructions: string | undefined, emit: (event: AgentEvent) => void, signal: AbortSignal): Promise<{ before: number; after: number }>;
    invalidate(sessionId: string): void;
    remove?(sessionId: string): void;
  };
}

export function createLiteAgentFacade(
  runtime: LiteAgentRuntime,
  workdir: string,
  sessions: SessionRunner<LiteAgentResult>,
  hooks: HookRuntime,
  ownsHooks: boolean,
  mcp: McpRegistry,
  closeRuntime?: () => Promise<void>,
): LiteAgent {
  let currentSessionId = newSessionId();
  let closePromise: Promise<void> | undefined;
  const noSessions = (): Promise<never> =>
    Promise.reject(
      new AgentError("session management requires a checkpointer (it is disabled when sessions:false)"),
    );

  const recordSessionEvent = async (sessionId: string, event: SessionEvent) => {
    await runtime.state.append(sessionId, [event], await runtime.state.head(sessionId));
  };
  sessions.bind((input, opts) => {
    const prepared = (async function* () {
      const release = mcp.enterRun();
      try {
        yield* streamOperation<AgentEvent, void>((emit, signal) => mcp.prepare({
          sessionId: opts.sessionId, signal, emit,
          recordSessionEvent: (event) => recordSessionEvent(opts.sessionId, event),
        }), opts.signal);
        runtime.refreshTools?.();
        return yield* runtime.core.run(input, opts);
      } finally { release(); }
    })();
    return hooks.run(prepared, input, opts, runtime.takeOutput, (event) => sessions.report(opts.sessionId, event));
  });

  const mutateMcp = async (operation: (scope: { sessionId: string; signal: AbortSignal; emit: (event: AgentEvent) => void; recordSessionEvent: (event: Parameters<typeof recordSessionEvent>[1]) => Promise<void> }) => Promise<void>) => {
    hooks.registry.assertNotInHook();
    if (!ownsHooks) throw new AgentError("Only the root agent can register MCP servers");
    const sessionId = currentSessionId;
    const stream = sessions.operation(sessionId, (emit, signal) => operation({ sessionId, signal, emit, recordSessionEvent: (event) => recordSessionEvent(sessionId, event) }));
    for await (const _event of stream) { /* session runner publishes operation events */ }
    runtime.refreshTools?.();
  };

  const run = (
    input: string | Message[],
    opts?: RunOptions,
  ): AsyncGenerator<AgentEvent, LiteAgentResult> => {
    hooks.registry.assertNotInHook();
    const sessionId = opts?.sessionId ?? currentSessionId;
    return sessions.run(input, { ...opts, sessionId });
  };

  return {
    mcp: {
      list: () => mcp.list(),
      register: (name, config) => mutateMcp((scope) => mcp.register(name, config, scope)),
      unregister: (name) => mutateMcp(() => mcp.unregister(name)),
    },
    run,
    hook: (name, handler, opts) => {
      if (closePromise) throw new AgentError("LiteAgent is closed");
      return hooks.registry.register(name, handler, opts);
    },
    subscribe: (listener) => sessions.subscribe(listener),
    awaitIdle: (sessionId = currentSessionId) => { hooks.registry.assertNotInHook(); return sessions.awaitIdle(sessionId); },
    close: () => {
      hooks.registry.assertNotInHook();
      if (ownsHooks) hooks.registry.stopRegistration();
      closePromise ??= (async () => {
        try {
          await sessions.close();
        } finally {
          try { await closeRuntime?.(); }
          finally {
            try { await runtime.dispose?.(); }
            finally { if (ownsHooks) hooks.registry.clear(); }
          }
        }
      })();
      return closePromise;
    },
    async send(input, opts) {
      const gen = run(input, opts);
      let result = await gen.next();
      while (!result.done) result = await gen.next();
      return result.value;
    },
    get sessionId() {
      return currentSessionId;
    },
    resume(id: string) {
      hooks.registry.assertNotInHook();
      currentSessionId = id;
      runtime.context?.invalidate(id);
    },
    clear() {
      hooks.registry.assertNotInHook();
      currentSessionId = newSessionId();
      return currentSessionId;
    },
    deleteSession: async (id: string) => {
      hooks.registry.assertNotInHook();
      await sessions.cancelSession(id);
      if (!runtime.checkpointer) return noSessions();
      await runtime.checkpointer.delete(id);
      runtime.removeSession?.(id);
      runtime.context?.invalidate(id);
    },
    listSessions: () =>
      runtime.checkpointer ? runtime.checkpointer.list() : noSessions(),
    listCheckpoints: async (id: string) => {
      if (!runtime.checkpointer) return noSessions();
      return checkpointList(await checkpointEntries(runtime.checkpointer, id));
    },
    restore: async (id, toSeq, opts = {}) => {
      hooks.registry.assertNotInHook();
      if (!runtime.checkpointer) return noSessions();
      const cp = runtime.checkpointer;
      const operation = sessions.operation(id, async (emit, signal) => {
        let completed = 0, total = 0;
        emit({ type: "checkpoint_restore", phase: "start", sessionId: id, toSeq, completed, total });
        try {
          const result = await restoreCheckpoint(cp, workdir, id, toSeq, opts, (done, count) => {
            completed = done; total = count;
            emit({ type: "checkpoint_restore", phase: "progress", sessionId: id, toSeq, completed, total });
          }, signal);
          runtime.context?.invalidate(id);
          currentSessionId = id;
          emit({ type: "checkpoint_restore", phase: "done", sessionId: id, toSeq, completed, total });
          return result;
        } catch (error) {
          emit({ type: "checkpoint_restore", phase: "error", sessionId: id, toSeq, completed, total, message: String(error) });
          throw error;
        }
      }, opts.signal);
      let next = await operation.next();
      while (!next.done) next = await operation.next();
      return next.value;
    },
    async *compact(instructions, opts) {
      hooks.registry.assertNotInHook();
      const id = currentSessionId;
      return yield* sessions.operation(id, (emit, signal) => hooks.manualCompact(id, instructions, emit, signal, async () => {
        if (runtime.context) return runtime.context.compact(id, instructions, emit, signal);
        let before = 0;
        emit({ type: "compaction", kind: "manual", phase: "start", stage: "measure", before, after: before });
        try {
          if (!runtime.compactor) throw new AgentError("compact requires context management or a compactor");
          const stored = await checkpointEntries(runtime.state, id);
          const messages = foldEvents(stored.map((entry) => entry.event));
          before = estimateTokens(messages);
          emit({ type: "compaction", kind: "manual", phase: "progress", stage: "summarize", before, after: before });
          const result = await abortable(runtime.compactor.maybeCompact(messages, { inputTokens: 0, outputTokens: 0 }, instructions, signal), signal);
          signal.throwIfAborted();
          const after = estimateTokens(result.messages);
          if (result.messages !== messages) {
            const head = stored.at(-1)?.seq ?? 0;
            emit({ type: "compaction", kind: "manual", phase: "progress", stage: "persist", before, after });
            await runtime.state.append(id, [{ type: "summary", messages: result.messages, throughSeq: head, before, after }], head);
          }
          emit({ type: "compaction", kind: "manual", phase: "done", stage: "persist", before, after });
          return { before, after };
        } catch (error) {
          emit({ type: "compaction", kind: "manual", phase: signal.aborted ? "cancelled" : "error", before, after: before, message: String(error) });
          throw error;
        }
      }), opts?.signal);
    },
  };
}
