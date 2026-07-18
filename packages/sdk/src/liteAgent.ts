import { AgentError, estimateTokens, foldEvents } from "@lite-agent/core";
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
  Sandbox,
  Store,
  Tool,
  ToolCallCodec,
  ToolChoice,
  TokenEstimator,
} from "@lite-agent/core";
import type { ContextPlannerProvider } from "@lite-agent/core";
import type { ZodType } from "zod";
import { existsSync, unlinkSync } from "node:fs";
import { atomicWriteFile, resolveSafePath } from "./tools/file";
import type { FileToolsOptions } from "./tools/file";
import type { BashToolOptions } from "./tools/bash";
import { newSessionId } from "./store";
import type { SessionInfo } from "./store";
import type { LiteAgentEvent, SessionRunner } from "./sessionRunner";

export type { LiteAgentEvent } from "./sessionRunner";

export type ContextOptions = {
  planner?: ContextPlannerProvider;
  windowTokens?: number;
};

export interface CreateLiteAgentConfig {
  model: ModelProvider;
  modelName?: string;
  workdir: string;
  skillsDir?: string;
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
  /**
   * Require a structured final answer. When set, a `final_answer` tool (whose
   * parameters are this schema) is registered and the model is instructed to call
   * it when done; the validated arguments surface as `result.output`. Must be an
   * object schema. Not inherited by subagents.
   */
  outputSchema?: ZodType;
  /** Max tool calls run concurrently per turn (default 10; 1 = sequential). Inherited by subagents. */
  maxParallelTools?: number;
  /** Prompt-codec repair attempts after malformed output. Default 2. */
  maxDecodeRetries?: number;
  use?: Middleware[];
  sandbox?: Sandbox;
  /** Event-sourced persistence backend. Default: fileCheckpointer under the project's sessions dir. Overrides `store`. */
  checkpointer?: Checkpointer;
  store?: Store;
  /** Override the global home (default `$LITE_AGENT_HOME` || `~/.lite-agent`). */
  home?: string;
  /** Persist sessions under the project's sessions dir (default fileCheckpointer). Default true. Ignored when `checkpointer`/`store` is set. */
  sessions?: boolean;
  /** @deprecated Use automatic `context` archive management. Kept as a one-release adapter. */
  spill?: boolean | { budgetBytes?: number };
  /** Persistent Tasks API (TaskCreate/Update/Get/List) + per-turn reminder. Default true. */
  tasks?: boolean;
  /** Task-list id under tasksDir. Default `$LITE_AGENT_TASK_LIST_ID` || "default". */
  taskListId?: string;
  /** File-defined subagents + the `Agent` dispatch tool. Default true. */
  agents?: boolean;
  /** Extra agents dir, appended last so it overrides global + project. */
  agentsDir?: string;
  /** Permission policy applied to subagent runs. Default: none (lenient — sandbox still applies). */
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

/** A run result, plus the validated structured answer when `outputSchema` is set. */
export type LiteAgentResult = RunResult & { output?: unknown };

export interface LiteAgent extends Agent {
  run(input: string | Message[], opts?: RunOptions): AsyncGenerator<AgentEvent, LiteAgentResult>;
  send(input: string | Message[], opts?: RunOptions): Promise<LiteAgentResult>;
  /** Observe user runs and autonomous background-completion runs. */
  subscribe(listener: (entry: LiteAgentEvent) => void): () => void;
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
  listCheckpoints(id: string): Promise<{ seq: number; prompt: string; ts: string }[]>;
  /** Roll a session back to the state right after event `toSeq`: revert files snapshotted after
   *  it (`files`) and/or truncate the conversation to it (`conversation`). Both default true.
   *  Sets the current session to `id`. Conversation rollback needs an event-sourced checkpointer
   *  with `truncate` (the default file/sqlite backends; a legacy `store` cannot). */
  restore(id: string, toSeq: number, opts?: { conversation?: boolean; files?: boolean }): Promise<void>;
  /** Manually compact the current session: compress the conversation, persist the result,
   *  emit progress + a completion notification, then stop. No model answer is produced.
   *  Optional `instructions` steer this compaction (Claude Code's `/compact <instructions>`) —
   *  passed to the compactor to bias what's preserved; only LLM-summary compactors act on it. */
  compact(instructions?: string): AsyncGenerator<AgentEvent, { before: number; after: number }>;
}

/** Internal construction result. Not re-exported from createLiteAgent.ts or index.ts. */
export interface LiteAgentRuntime {
  readonly core: Agent;
  readonly checkpointer?: Checkpointer;
  /** The effective composed compactor shared with manual compact(). */
  readonly compactor?: Compactor;
  /** Present only with outputSchema; returns and removes one session's capture. */
  readonly takeOutput?: (sessionId: string) => unknown;
  /** Internal context control shared by automatic and manual compaction. */
  readonly context?: {
    measure(sessionId: string): Promise<number>;
    compact(sessionId: string, instructions?: string): Promise<{ before: number; after: number }>;
    invalidate(sessionId: string): void;
    remove?(sessionId: string): void;
  };
}

export function createLiteAgentFacade(
  runtime: LiteAgentRuntime,
  workdir: string,
  sessions: SessionRunner<LiteAgentResult>,
): LiteAgent {
  let currentSessionId = newSessionId();
  const noSessions = (): Promise<never> =>
    Promise.reject(
      new AgentError("session management requires a checkpointer (it is disabled when sessions:false)"),
    );

  sessions.bind((input, opts) => {
    const gen = runtime.core.run(input, opts);
    const takeOutput = runtime.takeOutput;
    if (!takeOutput) return gen;
    return (async function* () {
      let result = await gen.next();
      while (!result.done) {
        yield result.value;
        result = await gen.next();
      }
      return { ...result.value, output: takeOutput(opts.sessionId) };
    })();
  });

  const run = (
    input: string | Message[],
    opts?: RunOptions,
  ): AsyncGenerator<AgentEvent, LiteAgentResult> => {
    const sessionId = opts?.sessionId ?? currentSessionId;
    return sessions.run(input, { ...opts, sessionId });
  };

  return {
    run,
    subscribe: (listener) => sessions.subscribe(listener),
    close: () => sessions.close(),
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
      currentSessionId = id;
      runtime.context?.invalidate(id);
    },
    clear() {
      currentSessionId = newSessionId();
      return currentSessionId;
    },
    deleteSession: async (id: string) => {
      await sessions.cancelSession(id);
      if (!runtime.checkpointer) return noSessions();
      await runtime.checkpointer.delete(id);
      runtime.context?.remove?.(id);
      runtime.context?.invalidate(id);
    },
    listSessions: () =>
      runtime.checkpointer ? runtime.checkpointer.list() : noSessions(),
    listCheckpoints: async (id: string) => {
      if (!runtime.checkpointer) return noSessions();
      const checkpoints: { seq: number; prompt: string; ts: string }[] = [];
      for await (const entry of runtime.checkpointer.read(id)) {
        if (entry.event.type === "user" && typeof entry.event.message.content === "string") {
          checkpoints.push({
            seq: entry.seq - 1,
            prompt: entry.event.message.content,
            ts: entry.ts,
          });
        }
      }
      return checkpoints;
    },
    restore: async (
      id: string,
      toSeq: number,
      opts?: { conversation?: boolean; files?: boolean },
    ) => {
      if (!runtime.checkpointer) return noSessions();
      const files = opts?.files ?? true;
      const conversation = opts?.conversation ?? true;
      if (files) {
        const earliest = new Map<
          string,
          {
            before: string | null;
            truncated?: boolean;
            encoding?: "utf8" | "base64";
          }
        >();
        for await (const entry of runtime.checkpointer.read(id, { sinceSeq: toSeq })) {
          if (entry.event.type === "file_snapshot" && !earliest.has(entry.event.path)) {
            earliest.set(entry.event.path, {
              before: entry.event.before,
              truncated: entry.event.truncated,
              encoding: entry.event.encoding,
            });
          }
        }
        for (const [path, snapshot] of earliest) {
          if (snapshot.truncated) continue;
          const file = resolveSafePath(workdir, path, {
            mode: snapshot.before === null ? "delete" : "write",
            symlinks: "deny",
          });
          if (snapshot.before === null) {
            if (existsSync(file)) unlinkSync(file);
          } else {
            const body = snapshot.encoding === "base64"
              ? Buffer.from(snapshot.before, "base64")
              : snapshot.before;
            atomicWriteFile(file, body);
          }
        }
      }
      if (conversation) {
        if (!runtime.checkpointer.truncate) {
          throw new AgentError("conversation restore requires a checkpointer that supports truncate");
        }
        await runtime.checkpointer.truncate(id, toSeq);
      }
      runtime.context?.invalidate(id);
      currentSessionId = id;
    },
    async *compact(instructions) {
      if (!runtime.checkpointer) {
        await noSessions();
        return { before: 0, after: 0 };
      }
      const id = currentSessionId;
      if (runtime.context) {
        const before = await runtime.context.measure(id);
        yield { type: "compaction", kind: "manual", phase: "start", before, after: before };
        const result = await runtime.context.compact(id, instructions);
        yield { type: "compaction", kind: "manual", phase: "done", before: result.before, after: result.after };
        return result;
      }
      if (!runtime.compactor) {
        throw new AgentError("compact requires a compactor (it is disabled when compactor:false)");
      }
      const stored = [];
      for await (const entry of runtime.checkpointer.read(id)) stored.push(entry);
      const messages = foldEvents(stored.map((entry) => entry.event));
      const before = estimateTokens(messages);
      yield { type: "compaction", kind: "manual", phase: "start", before, after: before };
      const result = await runtime.compactor.maybeCompact(
        messages,
        { inputTokens: 0, outputTokens: 0 },
        instructions,
      );
      const after = estimateTokens(result.messages);
      if (result.messages !== messages) {
        const head = stored.length ? stored[stored.length - 1]!.seq : 0;
        await runtime.checkpointer.append(
          id,
          [{ type: "summary", messages: result.messages, throughSeq: head, before, after }],
          head,
        );
      }
      yield { type: "compaction", kind: "manual", phase: "done", before, after };
      return { before, after };
    },
  };
}
