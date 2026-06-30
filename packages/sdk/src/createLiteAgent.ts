import {
  createAgent,
  nativeCodec,
  permission,
  compaction,
  reactiveCompaction,
  defaultCompactor,
  legacyStoreAdapter,
  foldEvents,
  estimateTokens,
  AgentError,
} from "@lite-agent/core";
import type {
  Agent,
  AgentEvent,
  ApprovalHandler,
  Checkpointer,
  Compactor,
  InputHandler,
  Message,
  Middleware,
  ModelProvider,
  PermissionPolicy,
  RunOptions,
  RunResult,
  Sandbox,
  Store,
  Tool,
  ToolChoice,
} from "@lite-agent/core";
import type { ZodType } from "zod";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { makeSafePath } from "./tools/file";
import { tool } from "./tool";
import { defaultTools, askUserTool } from "./tools";
import { SkillLoader } from "./skills/loader";
import { loadSkillTool } from "./skills/loadSkillTool";
import { buildSystemPrompt } from "./system";
import { resolveProjectPaths } from "./paths";
import { newSessionId } from "./store";
import type { SessionInfo } from "./store";
import { fileCheckpointer } from "./checkpoint";
import { fileSpillStore, readSpilledTool } from "./spill";
import { sweepStale } from "./cleanup";
import { fileTaskStore } from "./tasks/store";
import { taskTools } from "./tools/task";
import { taskReminder } from "./tasks/reminder";
import { AgentLoader } from "./agents/loader";
import { builtinAgents } from "./agents/builtin";
import { agentTool } from "./tools/agent";
import type { Spawn } from "./tools/agent";

export interface CreateLiteAgentConfig {
  model: ModelProvider;
  modelName?: string;
  workdir: string;
  skillsDir?: string;
  tools?: Tool[];
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
  use?: Middleware[];
  sandbox?: Sandbox;
  /** Event-sourced persistence backend. Default: fileCheckpointer under the project's sessions dir. Overrides `store`. */
  checkpointer?: Checkpointer;
  store?: Store;
  /** Override the global home (default `$LITE_AGENT_HOME` || `~/.lite-agent`). */
  home?: string;
  /** Persist sessions under the project's sessions dir (default fileCheckpointer). Default true. Ignored when `checkpointer`/`store` is set. */
  sessions?: boolean;
  /** Spill oversized tool_results to disk + register `read_spilled`. Default true. */
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
  /** Proactive compactor. Default deterministic `defaultCompactor`; `false` disables compaction. */
  compactor?: Compactor | false;
  /** Sweep stale spill/session files once at startup. Default true (30 days). */
  cleanup?: boolean | { maxAgeDays?: number };
  permission?: PermissionPolicy;
  onApproval?: ApprovalHandler;
  onAskUser?: InputHandler;
}

/** A run result, plus the validated structured answer when `outputSchema` is set. */
export type LiteAgentResult = RunResult & { output?: unknown };

export interface LiteAgent extends Agent {
  run(input: string | Message[], opts?: RunOptions): AsyncGenerator<AgentEvent, LiteAgentResult>;
  send(input: string | Message[], opts?: RunOptions): Promise<LiteAgentResult>;
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
   *  emit progress + a completion notification, then stop. No model answer is produced. */
  compact(): AsyncGenerator<AgentEvent, { before: number; after: number }>;
}

export function createLiteAgent(cfg: CreateLiteAgentConfig): LiteAgent {
  const paths = resolveProjectPaths({ workdir: cfg.workdir, home: cfg.home });

  // Age-based cleanup runs once at construction (global sweep, fully guarded).
  if (cfg.cleanup !== false) {
    sweepStale({
      home: paths.home,
      maxAgeDays: typeof cfg.cleanup === "object" ? cfg.cleanup.maxAgeDays : undefined,
    });
  }

  let tools: Tool[] = [...defaultTools(cfg.workdir)];

  // Skills: global < project < explicit skillsDir (later overrides earlier).
  const loader = new SkillLoader([
    paths.globalSkillsDir,
    paths.projectSkillsDir,
    ...(cfg.skillsDir ? [cfg.skillsDir] : []),
  ]);
  let skills = "(no skills available)";
  if (loader.names().length > 0) {
    tools.push(loadSkillTool(loader));
    skills = loader.getDescriptions();
  }

  // L3 spill: content-addressed store + retrieval tool, on by default.
  const spillEnabled = cfg.spill !== false;
  const spillStore = spillEnabled ? fileSpillStore({ dir: paths.spillDir }) : undefined;
  if (spillStore) tools.push(readSpilledTool(spillStore));

  // Persistent Tasks API: store closed over by the four tools + the reminder.
  const tasksEnabled = cfg.tasks !== false;
  const taskStore = tasksEnabled
    ? fileTaskStore({
        dir: paths.tasksDir,
        listId: cfg.taskListId ?? process.env.LITE_AGENT_TASK_LIST_ID ?? "default",
      })
    : undefined;
  if (taskStore) tools.push(...taskTools(taskStore));

  // Subagents: file-defined agents + the parallel `Agent` dispatch tool.
  let subagents: string | undefined;
  if (cfg.agents !== false) {
    const agentLoader = new AgentLoader(
      [
        paths.globalAgentsDir,
        paths.projectAgentsDir,
        ...(cfg.agentsDir ? [cfg.agentsDir] : []),
      ],
      builtinAgents(), // built-in general-purpose agent: subagents work with no files
    );
    if (agentLoader.names().length > 0) {
      subagents = agentLoader.getDescriptions();
      const spawn: Spawn = async (def, prompt, { signal, sessionId, onEvent }) => {
        const child = createLiteAgent({
          // `tools`/`use` intentionally inherit: the child is a full lite-agent in the
          // same project, so an absent `def.tools` means "inherit the parent's tool set"
          // and cross-cutting middleware still applies. Interactive handlers do NOT.
          ...cfg,
          system:
            `You are the "${def.name}" subagent operating in ${cfg.workdir}. ` +
            `Return your final answer as your last message.\n\n${def.body}`,
          modelName: def.model ?? cfg.modelName,
          allowedTools: def.tools ?? cfg.allowedTools,
          agents: false, // no recursion: the child gets no Agent tool
          cleanup: false, // the parent already swept at startup
          permission: cfg.subagentPermission, // undefined → lenient (no gate)
          onApproval: undefined, // don't share the interactive approval handler (parallel-unsafe)
          onAskUser: undefined, // subagents run non-interactively (no ask_user prompts)
          outputSchema: undefined, // subagents return their answer as text, not via final_answer
          checkpointer: undefined, // child rebuilds its own fileCheckpointer from the shared sessions dir (keyed by its sessionId)
        });
        const gen = child.run([{ role: "user", content: prompt }], { signal, sessionId });
        let r = await gen.next();
        while (!r.done) { onEvent?.(r.value); r = await gen.next(); }
        return r.value.text;
      };
      tools.push(agentTool({ loader: agentLoader, spawn }));
    }
  }

  if (cfg.tools) tools.push(...cfg.tools);
  if (cfg.onAskUser) tools.push(askUserTool());
  if (cfg.allowedTools)
    tools = tools.filter((t) => cfg.allowedTools!.includes(t.name));
  if (cfg.disallowedTools)
    tools = tools.filter((t) => !cfg.disallowedTools!.includes(t.name));

  // Structured output: register `final_answer` (after filtering, so it can't be
  // dropped) and capture its validated input per session. The answer surfaces as
  // `result.output`; `run`/`send` are wrapped below to attach it.
  const outputs = new Map<string, unknown>();
  if (cfg.outputSchema) {
    tools.push(
      tool(
        "final_answer",
        "Call this exactly once, when the task is complete, to return your final answer. " +
          "Pass the result as the arguments. Do not call it before you are done.",
        cfg.outputSchema,
        (input, ctx) => {
          outputs.set(ctx.sessionId, input);
          return "Final answer recorded.";
        },
      ),
    );
  }

  let system =
    cfg.system ??
    buildSystemPrompt({ workdir: cfg.workdir, modelName: cfg.modelName, skills, subagents });
  if (cfg.outputSchema) {
    system +=
      "\n\n## Final answer\n" +
      "When you have fully completed the task, you MUST call the `final_answer` tool " +
      "exactly once with your result. Do not put the final result in a normal message — " +
      "only the `final_answer` tool call is read as the answer.";
  }

  // Compaction: explicit compactor wins; `false` disables; default = deterministic
  // pipeline with the spill store auto-injected (no LLM call ever by default).
  const compactor =
    cfg.compactor === false
      ? undefined
      : cfg.compactor ??
        defaultCompactor({
          spillStore,
          budgetBytes: typeof cfg.spill === "object" ? cfg.spill.budgetBytes : undefined,
        });

  // Sessions: explicit checkpointer wins; else a legacy `store` is adapted; else the
  // default event-sourced fileCheckpointer, unless sessions:false disables persistence.
  const checkpointer: Checkpointer | undefined =
    cfg.checkpointer ??
    (cfg.store
      ? legacyStoreAdapter(cfg.store)
      : cfg.sessions === false
        ? undefined
        : fileCheckpointer({ dir: paths.sessionsDir }));

  const use: Middleware[] = [
    // proactive compaction (beforeModel) + reactive overflow net (wrapModelCall)
    ...(compactor ? [compaction(compactor), reactiveCompaction()] : []),
    ...(cfg.permission ? [permission(cfg.permission, cfg.onApproval)] : []),
    ...(cfg.use ?? []),
    ...(taskStore ? [taskReminder(taskStore)] : []),
  ];

  const core = createAgent({
    model: cfg.model,
    modelName: cfg.modelName,
    codec: nativeCodec(),
    tools,
    use,
    system,
    maxTurns: cfg.maxTurns,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    topP: cfg.topP,
    toolChoice: cfg.toolChoice,
    seed: cfg.seed,
    maxParallelTools: cfg.maxParallelTools,
    sandbox: cfg.sandbox,
    checkpointer,
    input: cfg.onAskUser,
  });

  // Stateful session ownership lives here (sdk), not in the primitive core agent.
  let currentSessionId = newSessionId();
  const noSessions = (): Promise<never> =>
    Promise.reject(
      new AgentError("session management requires a checkpointer (it is disabled when sessions:false)"),
    );

  // Drive the core run, then (when outputSchema is set) attach the captured answer.
  const run = (input: string | Message[], opts?: RunOptions): AsyncGenerator<AgentEvent, LiteAgentResult> => {
    const sessionId = opts?.sessionId ?? currentSessionId;
    const gen = core.run(input, { ...opts, sessionId });
    if (!cfg.outputSchema) return gen;
    return (async function* () {
      let res = await gen.next();
      while (!res.done) {
        yield res.value;
        res = await gen.next();
      }
      const output = outputs.get(sessionId);
      outputs.delete(sessionId);
      return { ...res.value, output };
    })();
  };

  return {
    run,
    async send(input, opts) {
      const gen = run(input, opts);
      let r = await gen.next();
      while (!r.done) r = await gen.next();
      return r.value;
    },
    get sessionId() {
      return currentSessionId;
    },
    resume(id: string) {
      currentSessionId = id;
    },
    clear() {
      currentSessionId = newSessionId();
      return currentSessionId;
    },
    deleteSession: (id: string) => (checkpointer ? checkpointer.delete(id) : noSessions()),
    listSessions: () => (checkpointer ? checkpointer.list() : noSessions()),
    listCheckpoints: async (id: string) => {
      if (!checkpointer) return noSessions();
      const out: { seq: number; prompt: string; ts: string }[] = [];
      for await (const e of checkpointer.read(id)) {
        if (e.event.type === "user" && typeof e.event.message.content === "string") {
          // `seq - 1` = the restore target that lands just BEFORE this prompt (undoing it
          // and everything after), so `restore(id, cp.seq)` matches "rewind to this prompt".
          out.push({ seq: e.seq - 1, prompt: e.event.message.content, ts: e.ts });
        }
      }
      return out;
    },
    restore: async (id: string, toSeq: number, opts?: { conversation?: boolean; files?: boolean }) => {
      if (!checkpointer) return noSessions();
      const files = opts?.files ?? true;
      const conversation = opts?.conversation ?? true;
      if (files) {
        const safe = makeSafePath(cfg.workdir);
        const earliest = new Map<string, { before: string | null; truncated?: boolean }>();
        for await (const e of checkpointer.read(id, { sinceSeq: toSeq })) {
          if (e.event.type === "file_snapshot" && !earliest.has(e.event.path)) {
            earliest.set(e.event.path, { before: e.event.before, truncated: e.event.truncated });
          }
        }
        for (const [path, snap] of earliest) {
          if (snap.truncated) continue;
          const fp = safe(path);
          if (snap.before === null) { if (existsSync(fp)) unlinkSync(fp); }
          else { mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, snap.before); }
        }
      }
      if (conversation) {
        if (!checkpointer.truncate)
          throw new AgentError("conversation restore requires a checkpointer that supports truncate");
        await checkpointer.truncate(id, toSeq);
      }
      currentSessionId = id;
    },
    async *compact() {
      if (!checkpointer) { await noSessions(); return { before: 0, after: 0 }; }
      if (!compactor) throw new AgentError("compact requires a compactor (it is disabled when compactor:false)");
      const id = currentSessionId;
      const stored = [];
      for await (const e of checkpointer.read(id)) stored.push(e);
      const messages = foldEvents(stored.map((s) => s.event));
      const before = estimateTokens(messages);
      yield { type: "compaction", kind: "manual", phase: "start", before, after: before };
      const result = await compactor.maybeCompact(messages, { inputTokens: 0, outputTokens: 0 });
      const after = estimateTokens(result.messages);
      if (result.messages !== messages) {
        const head = stored.length ? stored[stored.length - 1]!.seq : 0;
        await checkpointer.append(
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
