import { storageDirectory } from "../storageFiles";
import { atomicWriteFile } from "../tools/file";
import { storageEncoding, StorageError } from "../storage";
import type { StorageEncoding } from "../storage";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import type { Task, TaskStore, CreateTaskInput, UpdateTaskInput, TaskStatus } from "./types";

const MARK: Record<TaskStatus, string> = { pending: "[ ]", in_progress: "[>]", review: "[?]", completed: "[x]", failed: "[!]", cancelled: "[-]" };
const LOCK_OPTS = { retries: { retries: 20, factor: 1.4, minTimeout: 5, maxTimeout: 100 } };

// DFS over the blockedBy graph; true if any back-edge (unresolvable deadlock) exists.
function hasCycle(map: Map<string, Task>): boolean {
  const GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const visit = (id: string): boolean => {
    color.set(id, GRAY);
    for (const dep of map.get(id)?.blockedBy ?? []) {
      if (!map.has(dep)) continue;
      const c = color.get(dep);
      if (c === GRAY) return true;
      if (c === undefined && visit(dep)) return true;
    }
    color.set(id, BLACK);
    return false;
  };
  for (const id of map.keys()) {
    if (color.get(id) === undefined && visit(id)) return true;
  }
  return false;
}

export interface FileTaskStoreOptions extends StorageEncoding {
  /** Parent dir (paths.tasksDir). The list lives under `<dir>/<listId>/`. */
  dir: string;
  /** Which task list — one subdir per id. */
  listId: string;
}

export function fileTaskStore(opts: FileTaskStoreOptions): TaskStore {
  if (!/^[a-zA-Z0-9_-]+$/.test(opts.listId)) throw new StorageError("File task-list ids must contain only letters, digits, underscores or hyphens");
  const safe = storageDirectory(join(opts.dir, opts.listId));
  const fileFor = (id: string) => safe(`${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

  const encoding = storageEncoding(opts);
  const encode = (task: Task) => encoding.encode(JSON.stringify(task, null, 2), encoding.context("task", opts.listId, task.id));
  const readTask = async (id: string): Promise<Task> => {
    const text = await encoding.decode(readFileSync(fileFor(id), "utf8"), encoding.context("task", opts.listId, id));
    try {
      const task = JSON.parse(text) as Task;
      if (task.id !== id || typeof task.subject !== "string" || !Array.isArray(task.blockedBy) || !Array.isArray(task.blocks) || !(task.status in MARK))
        throw new Error("Invalid task");
      return task;
    } catch { throw new StorageError("Corrupt task record"); }
  };
  const readAll = async (): Promise<Task[]> => {
    const tasks: Task[] = [];
    for (const file of readdirSync(safe()).filter((f) => f.endsWith(".json")))
      tasks.push(await readTask(file.slice(0, -5)));
    return tasks.sort((a, b) => Number(a.id) - Number(b.id));
  };
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const release = await lock(safe(), LOCK_OPTS);
    try { return await fn(); } finally { await release(); }
  };
  const get = async (taskId: string): Promise<Task | null> => existsSync(fileFor(taskId)) ? readTask(taskId) : null;

  const store: TaskStore = {
    get: (id) => withLock(() => get(id)),
    list: () => withLock(readAll),

    async create(input: CreateTaskInput) {
      return withLock(async () => {
        const id = String((await readAll()).reduce((m, t) => Math.max(m, Number(t.id)), 0) + 1);
        const now = Date.now();
        const task: Task = {
          id,
          subject: input.subject,
          description: input.description,
          activeForm: input.activeForm,
          status: "pending",
          blockedBy: [],
          blocks: [],
          metadata: input.metadata,
          createdAt: now,
          updatedAt: now,
        };
        const encoded = await encode(task);
        atomicWriteFile(fileFor(task.id), encoded, 0o600);
        return task;
      });
    },

    async update(input: UpdateTaskInput) {
      return withLock(async () => {
        const map = new Map((await readAll()).map((t) => [t.id, t]));
        const task = map.get(input.taskId);
        if (!task) throw new Error(`no task '${input.taskId}'`);

        if (task.execution?.status === "running") {
          if (input.execution?.status === "running") throw new Error(`task '${task.id}' already has a running agent`);
          if (input.execution && input.execution.agentId !== task.execution.agentId)
            throw new Error(`task '${task.id}' belongs to another agent`);
          if (!input.execution && (input.status !== undefined || input.owner !== undefined))
            throw new Error(`task '${task.id}' is managed by a running agent`);
        }
        if (input.execution?.status === "running" && task.status === "completed")
          throw new Error(`reopen completed task '${task.id}' before dispatching it`);

        if (input.status !== undefined) task.status = input.status;
        if (input.subject !== undefined) task.subject = input.subject;
        if (input.description !== undefined) task.description = input.description;
        if (input.activeForm !== undefined) task.activeForm = input.activeForm;
        if (input.owner !== undefined) task.owner = input.owner;
        if (input.metadata !== undefined) task.metadata = { ...task.metadata, ...input.metadata };
        if (input.execution !== undefined) task.execution = input.execution;

        const touched = new Set<string>([task.id]);
        for (const other of input.addBlockedBy ?? []) {
          const o = map.get(other);
          if (!o) throw new Error(`no task '${other}'`);
          if (!task.blockedBy.includes(other)) task.blockedBy.push(other);
          if (!o.blocks.includes(task.id)) o.blocks.push(task.id);
          touched.add(other);
        }
        for (const other of input.addBlocks ?? []) {
          const o = map.get(other);
          if (!o) throw new Error(`no task '${other}'`);
          if (!task.blocks.includes(other)) task.blocks.push(other);
          if (!o.blockedBy.includes(task.id)) o.blockedBy.push(task.id);
          touched.add(other);
        }

        if (hasCycle(map)) throw new Error(`update would create a dependency cycle`);
        for (const id of touched) {
          const t = map.get(id)!;
          if (["in_progress", "review", "completed"].includes(t.status) &&
              t.blockedBy.some((dep) => map.get(dep)?.status !== "completed"))
            throw new Error(`task '${t.id}' has unfinished dependencies`);
        }

        const now = Date.now();
        const writes: Array<{ id: string; content: string }> = [];
        for (const id of touched) {
          const t = map.get(id)!;
          t.updatedAt = now;
          writes.push({ id, content: await encode(t) });
        }
        // Codec failures cannot commit a partial dependency update.
        for (const write of writes) atomicWriteFile(fileFor(write.id), write.content, 0o600);
        return task;
      });
    },

    async render(opts) {
      const all = await withLock(readAll);
      const completed = new Set(all.filter((t) => t.status === "completed").map((t) => t.id));
      const tasks = opts?.activeOnly ? all.filter((t) => t.status !== "completed" && t.status !== "cancelled") : all;
      if (!tasks.length) return "";
      return tasks
        .map((t) => {
          const unresolved = t.blockedBy.filter((id) => !completed.has(id));
          const dep = unresolved.length ? ` [blockedBy: ${unresolved.join(", ")}]` : "";
          const own = t.owner ? ` @${t.owner}` : "";
          return `${MARK[t.status]} #${t.id} ${t.subject} (${t.status})${dep}${own}`;
        })
        .join("\n");
    },
  };
  return store;
}
