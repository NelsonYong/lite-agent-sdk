import {
  createAgent,
  nativeCodec,
  permission,
  compaction,
  reactiveCompaction,
  defaultCompactor,
  tokenBudgetCompactor,
  legacyStoreAdapter,
} from "@lite-agent/core";
import type {
  Checkpointer,
  Compactor,
  Middleware,
  Tool,
} from "@lite-agent/core";
import { createLiteAgentFacade } from "./liteAgent";
import type { CreateLiteAgentConfig, LiteAgent } from "./liteAgent";

export type {
  CreateLiteAgentConfig,
  LiteAgent,
  LiteAgentResult,
} from "./liteAgent";

import { tool } from "./tool";
import { defaultTools, askUserTool } from "./tools";
import { SkillLoader } from "./skills/loader";
import { loadSkillTool } from "./skills/loadSkillTool";
import { buildSystemPrompt } from "./system";
import { resolveProjectPaths } from "./paths";
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
import { killBackgroundTool } from "./tools/killBackground";
import { bashOutputTool } from "./tools/bashOutput";

export function createLiteAgent(cfg: CreateLiteAgentConfig): LiteAgent {
  const paths = resolveProjectPaths({ workdir: cfg.workdir, home: cfg.home });

  // Age-based cleanup runs once at construction (global sweep, fully guarded).
  if (cfg.cleanup !== false) {
    sweepStale({
      home: paths.home,
      maxAgeDays: typeof cfg.cleanup === "object" ? cfg.cleanup.maxAgeDays : undefined,
      maxBytes: typeof cfg.cleanup === "object" ? cfg.cleanup.maxBytes : undefined,
    });
  }

  let tools: Tool[] = [...defaultTools(cfg.workdir, { files: cfg.fileTools, bash: cfg.bash })];

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
          // An explicit backend (notably SQLite in strict local mode) is safe to
          // share because child sessions use distinct ids. Undefined still lets
          // ordinary SDK children build the default project file checkpointer.
          checkpointer: cfg.checkpointer,
        });
        const gen = child.run([{ role: "user", content: prompt }], { signal, sessionId });
        let r = await gen.next();
        while (!r.done) { onEvent?.(r.value); r = await gen.next(); }
        return r.value.text;
      };
      tools.push(agentTool({ loader: agentLoader, spawn }));
    }
  }

  if (cfg.background !== false) tools.push(killBackgroundTool(), bashOutputTool());

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
        { security: { network: "none", filesystem: "none", sideEffects: "none" } },
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
  const structuralCompactor =
    cfg.compactor === false
      ? undefined
      : cfg.compactor ??
        defaultCompactor({
          spillStore,
          budgetBytes: typeof cfg.spill === "object" ? cfg.spill.budgetBytes : undefined,
        });
  const budgetCompactor = cfg.contextBudget
    ? tokenBudgetCompactor(cfg.contextBudget)
    : undefined;
  const compactor: Compactor | undefined = structuralCompactor && budgetCompactor
    ? {
        async maybeCompact(messages, usage, instructions) {
          const first = await structuralCompactor.maybeCompact(messages, usage, instructions);
          const second = await budgetCompactor.maybeCompact(first.messages, usage, instructions);
          return second.messages === first.messages
            ? first
            : { ...second, before: first.before ?? second.before };
        },
      }
    : structuralCompactor ?? budgetCompactor;

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
    ...(cfg.permission
      ? [permission(cfg.permission, cfg.onApproval, {
          redact: cfg.redact,
          mode: cfg.permissionMode,
          audit: cfg.permissionAudit,
        })]
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

  return createLiteAgentFacade(
    { core, checkpointer, compactor, takeOutput },
    cfg.workdir,
  );
}
