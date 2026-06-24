import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import type { Task, TaskStore, CreateTaskInput, UpdateTaskInput, TaskStatus } from "./types";

const MARK: Record<TaskStatus, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
const LOCK_OPTS = { retries: { retries: 20, factor: 1.4, minTimeout: 5, maxTimeout: 100 } };

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

    // Implemented in Task 3.
    async update(_input: UpdateTaskInput): Promise<Task> {
      throw new Error("not implemented");
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
