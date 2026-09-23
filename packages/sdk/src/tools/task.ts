import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";
import { taskStoreFor } from "../tasks/scope";
import type { TaskStoreSource } from "../tasks/scope";

const STATUS = z.enum(["pending", "in_progress", "review", "completed", "failed", "cancelled"]);
const META = z.record(z.string(), z.unknown()).optional();

export function taskTools(store: TaskStoreSource): Tool[] {
  const create = defineTool({
    name: "TaskCreate",
    description:
      "Create a task in the persistent task list. Use for complex multi-step work (3+ steps) or when the user gives multiple requests. Provide an imperative `subject` and a detailed `description`. Returns the new task id.",
    schema: z.object({
      subject: z.string().min(1),
      description: z.string(),
      activeForm: z.string().optional(),
      metadata: META,
    }),
    security: { network: "none", filesystem: "unrestricted", sideEffects: "workspace" },
    execute: async (input, ctx) => {
      const t = await taskStoreFor(store, ctx.sessionId).create(input);
      ctx.emit({ type: "task_update", taskId: t.id, status: t.status });
      return `Created task #${t.id}: ${t.subject}`;
    },
  });

  const update = defineTool({
    name: "TaskUpdate",
    description:
      "Update a task: mark completed ONLY after verifying its result. Delegated work moves to review on success, failed or cancelled otherwise. Running agent states are managed automatically. Set owner or add dependencies via addBlockedBy/addBlocks. Unfinished dependencies block execution and completion; cycles are rejected.",
    schema: z.object({
      taskId: z.string(),
      status: STATUS.optional(),
      subject: z.string().optional(),
      description: z.string().optional(),
      activeForm: z.string().optional(),
      owner: z.string().optional(),
      addBlockedBy: z.array(z.string()).optional(),
      addBlocks: z.array(z.string()).optional(),
      metadata: META,
    }),
    security: { network: "none", filesystem: "unrestricted", sideEffects: "workspace" },
    execute: async (input, ctx) => {
      const t = await taskStoreFor(store, ctx.sessionId).update(input);
      ctx.emit({ type: "task_update", taskId: t.id, status: t.status });
      return `Updated task #${t.id}: ${t.subject} (${t.status})`;
    },
  });

  const get = defineTool({
    name: "TaskGet",
    description: "Fetch the full detail of one task by id (description, status, dependency edges).",
    schema: z.object({ taskId: z.string() }),
    security: { network: "none", filesystem: "unrestricted", sideEffects: "none" },
    execute: ({ taskId }, ctx) => {
      const t = taskStoreFor(store, ctx.sessionId).get(taskId);
      return t ? JSON.stringify(t, null, 2) : `No task '${taskId}'`;
    },
  });

  const list = defineTool({
    name: "TaskList",
    description: "List every task with its status and blockedBy dependencies.",
    schema: z.object({}),
    security: { network: "none", filesystem: "unrestricted", sideEffects: "none" },
    execute: (_, ctx) => taskStoreFor(store, ctx.sessionId).render() || "No tasks.",
  });

  return [create, update, get, list];
}
