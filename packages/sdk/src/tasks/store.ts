import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import type { Task, TaskStore, CreateTaskInput, UpdateTaskInput, TaskStatus } from "./types";

const MARK: Record<TaskStatus, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
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

export interface FileTaskStoreOptions {
  /** Parent dir (paths.tasksDir). The list lives under `<dir>/<listId>/`. */
  dir: string;
  /** Which task list — one subdir per id. */
  listId: string;
}

export function fileTaskStore(opts: FileTaskStoreOptions): TaskStore {
  const dir = join(opts.dir, opts.listId.replace(/[^a-zA-Z0-9_-]/g, "_"));
  const fileFor = (id: string) => join(dir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

  const readAll = (): Task[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Task)
      .sort((a, b) => Number(a.id) - Number(b.id));
  };

  const writeAtomic = (task: Task): void => {
    const tmp = `${fileFor(task.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(task, null, 2));
    renameSync(tmp, fileFor(task.id)); // atomic on POSIX → readers never see a torn file
  };

  const withLock = async <T>(fn: () => T): Promise<T> => {
    mkdirSync(dir, { recursive: true });
    const release = await lock(dir, LOCK_OPTS);
    try {
      return fn();
    } finally {
      await release();
    }
  };

  const get = (taskId: string): Task | null => {
    const fp = fileFor(taskId);
    return existsSync(fp) ? (JSON.parse(readFileSync(fp, "utf8")) as Task) : null;
  };

  const store: TaskStore = {
    get,
    list: readAll,

    async create(input: CreateTaskInput) {
      return withLock(() => {
        const id = String(readAll().reduce((m, t) => Math.max(m, Number(t.id)), 0) + 1);
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
        writeAtomic(task);
        return task;
      });
    },

    async update(input: UpdateTaskInput) {
      return withLock(() => {
        const map = new Map(readAll().map((t) => [t.id, t]));
        const task = map.get(input.taskId);
        if (!task) throw new Error(`no task '${input.taskId}'`);

        if (input.status !== undefined) task.status = input.status;
        if (input.subject !== undefined) task.subject = input.subject;
        if (input.description !== undefined) task.description = input.description;
        if (input.activeForm !== undefined) task.activeForm = input.activeForm;
        if (input.owner !== undefined) task.owner = input.owner;
        if (input.metadata !== undefined) task.metadata = { ...task.metadata, ...input.metadata };

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

        const now = Date.now();
        for (const id of touched) {
          const t = map.get(id)!;
          t.updatedAt = now;
          writeAtomic(t); // only reached after all validation → no partial write on error
        }
        return task;
      });
    },

    render() {
      const tasks = readAll();
      if (!tasks.length) return "";
      return tasks
        .map((t) => {
          const dep = t.blockedBy.length ? ` [blockedBy: ${t.blockedBy.join(", ")}]` : "";
          const own = t.owner ? ` @${t.owner}` : "";
          return `${MARK[t.status]} #${t.id} ${t.subject} (${t.status})${dep}${own}`;
        })
        .join("\n");
    },
  };
  return store;
}
