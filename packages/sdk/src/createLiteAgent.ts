import {
  createAgent,
  nativeCodec,
  permission,
  compaction,
  reactiveCompaction,
  defaultCompactor,
  AgentError,
} from "@lite-agent/core";
import type {
  Agent,
  AgentEvent,
  ApprovalHandler,
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
import { tool } from "./tool";
import { defaultTools, askUserTool } from "./tools";
import { SkillLoader } from "./skills/loader";
import { loadSkillTool } from "./skills/loadSkillTool";
import { buildSystemPrompt } from "./system";
import { resolveProjectPaths } from "./paths";
import { jsonlStore, newSessionId, isSessionStore } from "./store";
import type { SessionInfo } from "./store";
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
  store?: Store;
  /** Override the global home (default `$LITE_AGENT_HOME` || `~/.lite-agent`). */
  home?: string;
  /** Persist transcripts under the project's sessions dir. Default true. Ignored when `store` is set. */
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
      const spawn: Spawn = async (def, prompt, { signal, sessionId }) => {
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
        });
        const r = await child.send([{ role: "user", content: prompt }], { signal, sessionId });
        return r.text;
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

  // Sessions: explicit store wins; else default jsonlStore unless sessions:false.
  const store =
    cfg.store ?? (cfg.sessions === false ? undefined : jsonlStore({ dir: paths.sessionsDir }));

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
    store,
    input: cfg.onAskUser,
  });

  // Stateful session ownership lives here (sdk), not in the primitive core agent.
  let currentSessionId = newSessionId();
  const sessionStore = isSessionStore(store) ? store : undefined;
  const noSessionStore = (): Promise<never> =>
    Promise.reject(new AgentError("session management requires a session-capable store"));

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
    deleteSession: (id: string) => sessionStore ? sessionStore.delete(id) : noSessionStore(),
    listSessions: () => sessionStore ? sessionStore.list() : noSessionStore(),
  };
}
