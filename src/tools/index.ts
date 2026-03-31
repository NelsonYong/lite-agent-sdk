import {
  AGENT_TEAM_SCHEMA,
  BUS,
  handlePlanReview,
  handleShutdownRequest,
  shutdownRequests,
  TEAM,
} from "../agent/agentTeam";
import { BG, BG_TOOL_SCHEMA } from "../agent/background";
import { getSkillLoader } from "../agent/skill";
import { runSubagent } from "../agent/subagent";
import { WORKTREES, EVENTS, WORKTREE_SCHEMA } from "../agent/worktree";
import { BASH_TOOL_SCHEMA, runBash } from "./bash";
import { editFile, FILE_TOOL_SCHEMA, readFile, writeFile } from "./file";
import { TASK_OPERATIONS_SCHEMA, TASKS, TaskStatus } from "./task";
import { TODO, TODO_TOOL_SCHEMA, TodoInput } from "./todo";

export const AGENT_TOOL_SCHEMA = {
  name: "agent",
  description:
    "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string",
        description: "The task prompt for the subagent",
      },
      description: {
        type: "string",
        description: "Short description of the task",
      },
    },
    required: ["prompt"],
  },
};

export const COMPACT_TOOL_SCHEMA = {
  name: "compact",
  description: "Trigger manual conversation compression.",
  input_schema: {
    type: "object" as const,
    properties: {
      focus: { type: "string", description: "What to preserve in the summary" },
    },
  },
};

export const toolHandlers: Record<
  string,
  (input: any) => string | Promise<string>
> = {
  bash: ({ command }: { command: string }) => runBash(command),
  read_file: ({ path, limit }: { path: string; limit: number }) =>
    readFile(path, limit),
  write_file: ({ path, content }: { path: string; content: string }) =>
    writeFile(path, content),
  edit_file: ({
    path,
    old_text,
    new_text,
  }: {
    path: string;
    old_text: string;
    new_text: string;
  }) => editFile(path, old_text, new_text),
  todo: ({ items }: { items: TodoInput[] }) => TODO.update(items),
  load_skill: ({ name }: { name: string }) => getSkillLoader().getContent(name),
  agent: ({ prompt }: { prompt: string }) => runSubagent(prompt),

  // task
  task_create: ({
    subject,
    description,
    owner,
  }: {
    subject: string;
    description: string;
    owner: string;
  }) => TASKS.create(subject, description, owner),
  task_update: ({
    task_id,
    status,
    owner,
    addBlockedBy,
    addBlocks,
  }: {
    task_id: number;
    status: TaskStatus;
    owner: string;
    addBlockedBy: number[];
    addBlocks: number[];
  }) => TASKS.update(task_id, status, owner, addBlockedBy, addBlocks),
  task_list: () => TASKS.listAll(),
  task_get: ({ task_id }: { task_id: number }) => TASKS.get(task_id),
  task_bind_worktree: ({
    task_id,
    worktree,
    owner,
  }: {
    task_id: number;
    worktree: string;
    owner: string;
  }) => TASKS.bindWorktree(task_id, worktree, owner),
  claim_task: ({ task_id }: { task_id: number }) =>
    TASKS.claimTask(task_id, "lead"),

  // background
  background_run: ({ command, daemon }: { command: string; daemon?: boolean }) =>
    BG.run(command, daemon),
  check_background: ({ task_id }: { task_id: string }) => BG.check(task_id),
  stop_background: ({ task_id }: { task_id: string }) => BG.stop(task_id),

  // agent team
  spawn_teammate: ({ name, role, prompt }) => TEAM.spawn(name, role, prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: ({ to, content, msg_type }) =>
    BUS.send("lead", to, content, msg_type),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: ({ content }) =>
    BUS.broadcast("lead", content, TEAM.memberNames()),

  shutdown_request: ({ teammate }) => handleShutdownRequest(teammate),
  shutdown_response: ({ request_id }) =>
    JSON.stringify(shutdownRequests[request_id] || { error: "not found" }),
  force_shutdown: ({ teammate }) => TEAM.forceShutdown(teammate),
  plan_approval: ({ request_id, approve, feedback }) =>
    handlePlanReview(request_id, approve, feedback),

  // worktree
  worktree_create: ({
    name,
    task_id,
    base_ref,
  }: {
    name: string;
    task_id: number;
    base_ref: string;
  }) => WORKTREES.create(name, task_id ?? null, base_ref || "HEAD"),
  worktree_list: () => WORKTREES.listAll(),
  worktree_status: ({ name }: { name: string }) => WORKTREES.status(name),
  worktree_run: ({ name, command }: { name: string; command: string }) =>
    WORKTREES.run(name, command),
  worktree_remove: ({
    name,
    force,
    complete_task,
  }: {
    name: string;
    force: boolean;
    complete_task: boolean;
  }) => WORKTREES.remove(name, force, complete_task),
  worktree_keep: ({ name }: { name: string }) => WORKTREES.keep(name),
  worktree_events: ({ limit }: { limit: number }) =>
    EVENTS.listRecent(limit),
};

export const baseTools = [
  BASH_TOOL_SCHEMA,
  ...FILE_TOOL_SCHEMA,
  TODO_TOOL_SCHEMA,
];

export const mainAgentTools = [
  ...baseTools,
  ...AGENT_TEAM_SCHEMA,
  ...WORKTREE_SCHEMA,
  ...TASK_OPERATIONS_SCHEMA,
  AGENT_TOOL_SCHEMA,
  ...BG_TOOL_SCHEMA,
  COMPACT_TOOL_SCHEMA,
];

export const subagentTools = [...baseTools];
