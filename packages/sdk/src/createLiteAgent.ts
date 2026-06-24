import {
  createAgent,
  nativeCodec,
  permission,
  compaction,
  reactiveCompaction,
  defaultCompactor,
} from "@lite-agent/core";
import type {
  Agent,
  ApprovalHandler,
  Compactor,
  InputHandler,
  Middleware,
  ModelProvider,
  PermissionPolicy,
  Sandbox,
  Store,
  Tool,
} from "@lite-agent/core";
import { defaultTools, askUserTool } from "./tools";
import { SkillLoader } from "./skills/loader";
import { loadSkillTool } from "./skills/loadSkillTool";
import { buildSystemPrompt } from "./system";
import { resolveProjectPaths } from "./paths";
import { jsonlStore } from "./store";
import { fileSpillStore, readSpilledTool } from "./spill";
import { sweepStale } from "./cleanup";
import { fileTaskStore } from "./tasks/store";
import { taskTools } from "./tools/task";
import { taskReminder } from "./tasks/reminder";

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
  /** Proactive compactor. Default deterministic `defaultCompactor`; `false` disables compaction. */
  compactor?: Compactor | false;
  /** Sweep stale spill/session files once at startup. Default true (30 days). */
  cleanup?: boolean | { maxAgeDays?: number };
  permission?: PermissionPolicy;
  onApproval?: ApprovalHandler;
  onAskUser?: InputHandler;
}

export function createLiteAgent(cfg: CreateLiteAgentConfig): Agent {
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

  if (cfg.tools) tools.push(...cfg.tools);
  if (cfg.onAskUser) tools.push(askUserTool());
  if (cfg.allowedTools)
    tools = tools.filter((t) => cfg.allowedTools!.includes(t.name));
  if (cfg.disallowedTools)
    tools = tools.filter((t) => !cfg.disallowedTools!.includes(t.name));

  const system =
    cfg.system ??
    buildSystemPrompt({ workdir: cfg.workdir, modelName: cfg.modelName, skills });

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

  return createAgent({
    model: cfg.model,
    modelName: cfg.modelName,
    codec: nativeCodec(),
    tools,
    use,
    system,
    maxTurns: cfg.maxTurns,
    maxTokens: cfg.maxTokens,
    sandbox: cfg.sandbox,
    store,
    input: cfg.onAskUser,
  });
}
