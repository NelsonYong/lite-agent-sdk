import {
  compaction,
  createAgent,
  defaultCompactor,
  legacyStoreAdapter,
  nativeCodec,
  permission,
  reactiveCompaction,
  tokenBudgetCompactor,
} from "@lite-agent/core";
import type { Checkpointer, Compactor, Middleware, Tool } from "@lite-agent/core";
import { tool } from "./tool";
import { askUserTool, defaultTools } from "./tools";
import { SkillLoader } from "./skills/loader";
import { loadSkillTool } from "./skills/loadSkillTool";
import { buildSystemPrompt } from "./system";
import { fileCheckpointer } from "./checkpoint";
import { fileSpillStore, readSpilledTool } from "./spill";
import { fileTaskStore } from "./tasks/store";
import { taskTools } from "./tools/task";
import { taskReminder } from "./tasks/reminder";
import { AgentLoader } from "./agents/loader";
import { builtinAgents } from "./agents/builtin";
import { agentTool } from "./tools/agent";
import type { Spawn } from "./tools/agent";
import { killBackgroundTool } from "./tools/killBackground";
import { bashOutputTool } from "./tools/bashOutput";
import type { ProjectPaths } from "./paths";
import type { CreateLiteAgentConfig, LiteAgentRuntime } from "./liteAgent";

interface AssembleLiteAgentOptions {
  readonly cfg: CreateLiteAgentConfig;
  readonly paths: ProjectPaths;
  readonly spawn: Spawn;
}

export function assembleLiteAgent({
  cfg,
  paths,
  spawn,
}: AssembleLiteAgentOptions): LiteAgentRuntime {
  let tools: Tool[] = [
    ...defaultTools(cfg.workdir, { files: cfg.fileTools, bash: cfg.bash }),
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
  const spillStore = spillEnabled
    ? fileSpillStore({ dir: paths.spillDir })
    : undefined;
  if (spillStore) tools.push(readSpilledTool(spillStore));

  const tasksEnabled = cfg.tasks !== false;
  const taskStore = tasksEnabled
    ? fileTaskStore({
        dir: paths.tasksDir,
        listId: cfg.taskListId ?? process.env.LITE_AGENT_TASK_LIST_ID ?? "default",
      })
    : undefined;
  if (taskStore) tools.push(...taskTools(taskStore));

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
      tools.push(agentTool({ loader: agentLoader, spawn }));
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
      subagents,
    });
  if (cfg.outputSchema) {
    system +=
      "\n\n## Final answer\n" +
      "When you have fully completed the task, you MUST call the `final_answer` tool " +
      "exactly once with your result. Do not put the final result in a normal message — " +
      "only the `final_answer` tool call is read as the answer.";
  }

  const structuralCompactor =
    cfg.compactor === false
      ? undefined
      : cfg.compactor ??
        defaultCompactor({
          spillStore,
          budgetBytes:
            typeof cfg.spill === "object" ? cfg.spill.budgetBytes : undefined,
        });
  const budgetCompactor = cfg.contextBudget
    ? tokenBudgetCompactor(cfg.contextBudget)
    : undefined;
  const compactor: Compactor | undefined =
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

  const checkpointer: Checkpointer | undefined =
    cfg.checkpointer ??
    (cfg.store
      ? legacyStoreAdapter(cfg.store)
      : cfg.sessions === false
        ? undefined
        : fileCheckpointer({ dir: paths.sessionsDir }));

  const use: Middleware[] = [
    ...(compactor ? [compaction(compactor), reactiveCompaction()] : []),
    ...(cfg.permission
      ? [
          permission(cfg.permission, cfg.onApproval, {
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
    codec: cfg.codec ?? nativeCodec(),
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
    maxDecodeRetries: cfg.maxDecodeRetries,
    background: cfg.background,
    backgroundLimits: cfg.backgroundLimits,
    crashRecovery: cfg.crashRecovery,
    maxSnapshotBytesPerSession: cfg.maxSnapshotBytesPerSession,
    sandbox: cfg.sandbox,
    checkpointer,
    input: cfg.onAskUser,
  });

  const takeOutput = cfg.outputSchema
    ? (sessionId: string): unknown => {
        const output = outputs.get(sessionId);
        outputs.delete(sessionId);
        return output;
      }
    : undefined;

  return { core, checkpointer, compactor, takeOutput };
}
