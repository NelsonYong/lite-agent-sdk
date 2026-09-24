import type { HookRuntime } from "./hooks/runtime";
import type { McpRegistry } from "./mcp/registry";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  compaction,
  createAgent,
  defaultCompactor,
  ContextEngine,
  estimateTokens,
  legacyStoreAdapter,
  memoryCheckpointer,
  nativeCodec,
  permission,
  reactiveCompaction,
  tokenBudgetCompactor,
  toToolSpec,
} from "@lite-agent/core";
import type { AgentEvent, BackgroundTasks, Checkpointer, Compactor, Middleware, Tool } from "@lite-agent/core";
import { tool } from "./tool";
import { askUserTool, defaultTools } from "./tools";
import { SkillLoader } from "./skills/loader";
import { loadSkillTool } from "./skills/loadSkillTool";
import { buildSystemPrompt } from "./system";
import { workspacePolicy } from "./permission/workspace";
import { fileCheckpointer } from "./checkpoint";
import { fileSpillStore, readSpilledTool } from "./spill";
import { contextLookupTool, fileContextArchive } from "./contextArchive";
import type { ContextArchive as FileContextArchive } from "./contextArchive";
import { sessionContextDir } from "./paths";
import { fileTaskStore } from "./tasks/store";
import type { TaskStore } from "./tasks/types";
import { taskTools } from "./tools/task";
import { taskReminder } from "./tasks/reminder";
import { AgentLoader } from "./agents/loader";
import { builtinAgents } from "./agents/builtin";
import { agentTool } from "./tools/agent";
import type { Spawn } from "./tools/agent";
import type { SubagentPool } from "./subagentPool";
import { killBackgroundTool } from "./tools/killBackground";
import { bashOutputTool } from "./tools/bashOutput";
import type { ProjectPaths } from "./paths";
import type { LiteAgentRuntime, RuntimeLiteAgentConfig } from "./liteAgent";

interface AssembleLiteAgentOptions {
  readonly cfg: RuntimeLiteAgentConfig;
  readonly paths: ProjectPaths;
  readonly spawn: Spawn;
  readonly subagentPool: SubagentPool;
  readonly hooks: HookRuntime;
  readonly mcp: McpRegistry;
  readonly backgroundTasks: (sessionId: string) => BackgroundTasks | undefined;
}

export function assembleLiteAgent({
  cfg,
  paths,
  spawn,
  subagentPool,
  hooks,
  mcp,
  backgroundTasks,
}: AssembleLiteAgentOptions): LiteAgentRuntime {
  const readRoots = (sessionId: string): readonly string[] => [
    sessionContextDir(paths.sessionsDir, sessionId),
    ...(/^[a-zA-Z0-9_-]+$/.test(sessionId) ? [join(paths.sessionsDir, `${sessionId}.jsonl`)] : []),
    ...(cfg.fileTools?.readRoots?.(sessionId) ?? []),
  ];
  let tools: Tool[] = [
    ...defaultTools(cfg.workdir, { files: { ...cfg.fileTools, readRoots }, bash: cfg.bash }),
  ];

  const skillLoader = new SkillLoader([
    paths.globalSkillsDir,
    paths.projectSkillsDir,
    ...(cfg.skillsDir ? [cfg.skillsDir] : []),
  ]);
  let skills = "(no skills available)";
  if (skillLoader.names().length > 0) {
    tools.push(loadSkillTool(skillLoader));
    skills = skillLoader.getDescriptions();
  }

  const spillEnabled = cfg.spill !== false;
  const legacyContext = cfg.compactor !== undefined || cfg.contextBudget !== undefined || cfg.spill !== undefined;
  const contextConfig = typeof cfg.context === "object" ? cfg.context : undefined;
  let checkpointer: Checkpointer | undefined;
  const spillStore = legacyContext && spillEnabled
    ? fileSpillStore({ dir: paths.spillDir })
    : undefined;
  const archives = new Map<string, FileContextArchive>();
  const archiveFor = (sessionId: string): FileContextArchive => {
    const existing = archives.get(sessionId);
    if (existing) return existing;
    const archive = fileContextArchive({ dir: sessionContextDir(paths.sessionsDir, sessionId) });
    archives.set(sessionId, archive);
    return archive;
  };
  if (legacyContext && spillStore) tools.push(readSpilledTool(spillStore));
  tools.push(contextLookupTool({
    archiveFor,
    name: "context",
    generationFor: async (sessionId) => checkpointer?.head(sessionId) ?? 0,
  }));
  if (cfg.spill !== false && (!legacyContext || !spillStore)) {
    // Compatibility alias uses the same session archive and read boundaries.
    tools.push(contextLookupTool({
      archiveFor, name: "read_spilled", legacyMissing: true,
      generationFor: async (sessionId) => checkpointer?.head(sessionId) ?? 0,
    }));
  }

  const tasksEnabled = cfg.tasks !== false;
  const taskStores = new Map<string, TaskStore>();
  const taskStore = tasksEnabled ? (sessionId: string): TaskStore => {
    const listId = cfg.taskListId ?? process.env.LITE_AGENT_TASK_LIST_ID ?? sessionId;
    let store = taskStores.get(listId);
    if (!store) {
      store = fileTaskStore({ dir: paths.tasksDir, listId });
      taskStores.set(listId, store);
    }
    return store;
  } : undefined;
  if (taskStore) tools.push(...taskTools(taskStore));

  const descriptions = { simple: "bounded read-only lookup", medium: "ordinary implementation and tests", complex: "architecture, difficult debugging, or security review" };
  const modelDescription = cfg.models
    ? "Choose model from these configured profiles: " + Object.entries(cfg.models)
        .map(([tier, profile]) => `${tier}: ${descriptions[tier as keyof typeof descriptions]} (${profile.modelName}${profile.reasoningEffort ? `, reasoning ${profile.reasoningEffort}` : ""})`).join("; ")
    : undefined;
  let subagents: string | undefined;
  if (cfg.agents !== false) {
    const agentLoader = new AgentLoader(
      [
        paths.globalAgentsDir,
        paths.projectAgentsDir,
        ...(cfg.agentsDir ? [cfg.agentsDir] : []),
      ],
      builtinAgents(),
    );
    if (agentLoader.names().length > 0) {
      subagents = agentLoader.getDescriptions();
      tools.push(agentTool({ loader: agentLoader, spawn, pool: subagentPool,
        models: cfg.models ? Object.keys(cfg.models) : undefined, modelDescription, taskStore }));
    }
  }

  if (cfg.background !== false) {
    tools.push(killBackgroundTool(), bashOutputTool());
  }
  if (cfg.tools) tools.push(...cfg.tools);
  if (cfg.onAskUser) tools.push(askUserTool());
  if (cfg.allowedTools) {
    tools = tools.filter((entry) => cfg.allowedTools!.includes(entry.name));
  }
  if (cfg.disallowedTools) {
    tools = tools.filter((entry) => !cfg.disallowedTools!.includes(entry.name));
  }

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
        { security: { network: "none", filesystem: "none", sideEffects: "none" } },
      ),
    );
  }

  let system =
    cfg.system ??
    buildSystemPrompt({
      workdir: cfg.workdir,
      modelName: cfg.modelName,
      skills,
      subagents: tools.some((tool) => tool.name === "Agent") ? subagents : undefined,
      models: modelDescription,
      tasks: tools.some((tool) => tool.name === "TaskCreate"),
    });
  if (cfg.outputSchema) {
    system +=
      "\n\n## Final answer\n" +
      "When you have fully completed the task, you MUST call the `final_answer` tool " +
      "exactly once with your result. Do not put the final result in a normal message — " +
      "only the `final_answer` tool call is read as the answer.";
  }

  const codec = cfg.codec ?? nativeCodec();
  const baseTools = [...tools];
  const refreshTools = () => {
    const remote = mcp.tools().filter((tool) =>
      (!cfg.allowedTools || cfg.allowedTools.includes(tool.name)) && !cfg.disallowedTools?.includes(tool.name));
    tools.splice(0, tools.length, ...baseTools, ...remote);
  };
  refreshTools();
  const contextStaticPrefix = () => {
    refreshTools();
    const toolSpecs = tools.map(toToolSpec);
    const encoded = codec.encode({
      model: cfg.modelName ?? cfg.model.id,
      system,
      messages: [],
    }, toolSpecs);
    return {
      system: encoded.system,
      tools: encoded.tools ?? toolSpecs,
      codec: { id: codec.constructor?.name ?? "codec", streaming: codec.streaming },
    };
  };

  const structuralCompactor = !legacyContext
    ? undefined
    : cfg.compactor === false
      ? undefined
      : cfg.compactor ??
        defaultCompactor({
          spillStore,
          budgetBytes:
            typeof cfg.spill === "object" ? cfg.spill.budgetBytes : undefined,
        });
  const budgetCompactor = legacyContext && cfg.contextBudget
    ? tokenBudgetCompactor(cfg.contextBudget)
    : undefined;
  const baseCompactor: Compactor | undefined =
    structuralCompactor && budgetCompactor
      ? {
          async maybeCompact(messages, usage, instructions) {
            const first = await structuralCompactor.maybeCompact(
              messages,
              usage,
              instructions,
            );
            const second = await budgetCompactor.maybeCompact(
              first.messages,
              usage,
              instructions,
            );
            return second.messages === first.messages
              ? first
              : { ...second, before: first.before ?? second.before };
          },
        }
      : structuralCompactor ?? budgetCompactor;

  const compactor = baseCompactor ? hooks.compactor(baseCompactor) : undefined;
  checkpointer =
    cfg.checkpointer ??
    (cfg.store
      ? legacyStoreAdapter(cfg.store)
      : cfg.sessions === false
        ? memoryCheckpointer()
        : fileCheckpointer({ dir: paths.sessionsDir }));

  // `checkpointer` is declared above the tool closure at runtime; the tool is
  // invoked later, after assembly has completed, so this binding is safe.

  hooks.state = checkpointer;
  const use: Middleware[] = [
    hooks.middleware(),
    ...(compactor ? [compaction(compactor), reactiveCompaction()] : []),
    ...(cfg.permission
      ? [
          permission(workspacePolicy(cfg.permission, cfg.workdir, readRoots), cfg.onApproval, {
            redact: cfg.redact,
            mode: cfg.permissionMode,
            audit: cfg.permissionAudit,
          }),
        ]
      : []),
    ...(cfg.use ?? []),
    ...(taskStore ? [taskReminder(taskStore)] : []),
  ];

  const core = createAgent({
    model: cfg.model,
    modelName: cfg.modelName,
    codec,
    tools,
    use,
    system,
    maxTurns: cfg.maxTurns,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    topP: cfg.topP,
    toolChoice: cfg.toolChoice,
    seed: cfg.seed,
    reasoningEffort: cfg.reasoningEffort,
    maxParallelTools: cfg.maxParallelTools,
    maxDecodeRetries: cfg.maxDecodeRetries,
    background: cfg.background,
    backgroundLimits: cfg.backgroundLimits,
    backgroundTasks,
    crashRecovery: cfg.crashRecovery,
    maxSnapshotBytesPerSession: cfg.maxSnapshotBytesPerSession,
    sandbox: cfg.sandbox,
    checkpointer,
    input: cfg.onAskUser,
    archive: archiveFor,
    context: legacyContext || cfg.context === false
      ? false
      : {
          windowTokens: contextConfig?.windowTokens,
          planner: contextConfig?.planner,
          archive: archiveFor,
          onProgress: (event) => hooks.compaction(event),
        },
  });

  const context = !legacyContext && cfg.context !== false
    ? {
        measure: async (sessionId: string) => {
          const engine = new ContextEngine({
            sessionId,
            checkpointer,
            provider: cfg.model,
            model: cfg.modelName,
            windowTokens: contextConfig?.windowTokens,
            planner: contextConfig?.planner,
            archive: archiveFor(sessionId),
            staticPrefix: contextStaticPrefix(),
          });
          const view = await engine.snapshot();
          return estimateTokens([...view.messages]);
        },
        compact: async (sessionId: string, instructions: string | undefined, emit: (event: AgentEvent) => void, signal: AbortSignal) => {
          const engine = new ContextEngine({
            sessionId,
            checkpointer,
            provider: cfg.model,
            model: cfg.modelName,
            windowTokens: contextConfig?.windowTokens,
            planner: contextConfig?.planner,
            archive: archiveFor(sessionId),
            staticPrefix: contextStaticPrefix(),
            signal,
            onProgress: emit,
          });
          await engine.compact("manual", instructions);
          return { before: engine.status.beforeTokens, after: engine.status.afterTokens };
        },
        invalidate: (sessionId: string) => {
          archives.delete(sessionId);
        },
        remove: (sessionId: string) => {
          archives.delete(sessionId);
        },
      }
    : undefined;

  const takeOutput = cfg.outputSchema
    ? (sessionId: string): unknown => {
        const output = outputs.get(sessionId);
        outputs.delete(sessionId);
        return output;
      }
    : undefined;

  // Disabling disk sessions must not erase the goal between a user turn and a
  // background completion. Keep runtime state in memory, without exposing the
  // persistent session-management API in this mode.
  const persistent = cfg.checkpointer !== undefined || cfg.store !== undefined || cfg.sessions !== false;
  return {
    refreshTools,
    core, state: checkpointer, checkpointer: persistent ? checkpointer : undefined,
    compactor: legacyContext ? compactor : undefined, takeOutput, context,
    async dispose() {
      archives.clear();
      taskStores.clear();
      outputs.clear();
      if (!persistent) for (const entry of await checkpointer.list()) await checkpointer.delete(entry.id);
    },
    removeSession(sessionId) {
      archives.delete(sessionId);
      rmSync(sessionContextDir(paths.sessionsDir, sessionId), { recursive: true, force: true });
      if (!cfg.taskListId && !process.env.LITE_AGENT_TASK_LIST_ID) {
        taskStores.delete(sessionId);
        rmSync(join(paths.tasksDir, sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")), { recursive: true, force: true });
      }
    },
  };
}
