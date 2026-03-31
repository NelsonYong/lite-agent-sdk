import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type TaskStatus = "pending" | "in_progress" | "completed";

export const TASK_OPERATIONS_SCHEMA = [
  {
    name: "task_create",
    description: "Create a new task.",
    input_schema: {
      type: "object" as const,
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
        owner: {
          type: "string",
          description: "Owner identifier (e.g., teammate name)",
        },
      },
      required: ["subject"],
    },
  },
  {
    name: "task_update",
    description: "Update a task's status or dependencies.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "integer" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
        },
        owner: { type: "string" },
        addBlockedBy: { type: "array", items: { type: "integer" } },
        addBlocks: { type: "array", items: { type: "integer" } },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "List all tasks with status summary.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "task_get",
    description: "Get full details of a task by ID.",
    input_schema: {
      type: "object" as const,
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
  {
    name: "task_bind_worktree",
    description: "Bind a task to a worktree for isolated execution.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "integer" },
        worktree: { type: "string" },
        owner: { type: "string" },
      },
      required: ["task_id", "worktree"],
    },
  },
  {
    name: "claim_task",
    description: "Claim an unclaimed task from the board by ID.",
    input_schema: {
      type: "object" as const,
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
];

interface Task {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string;
  worktree: string;
  blockedBy: number[];
  blocks: number[];
}

const STATUS_MARKER: Record<TaskStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

const TASKS_DIR = join(process.cwd(), ".tasks");

let claimLock = false;

class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    try {
      const ids = readdirSync(this.dir)
        .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
        .map((f) => parseInt(f.split("_")[1]))
        .filter((n) => !isNaN(n));
      return ids.length ? Math.max(...ids) : 0;
    } catch {
      return 0;
    }
  }

  private taskPath(taskId: number): string {
    return join(this.dir, `task_${taskId}.json`);
  }

  private load(taskId: number): Task {
    const path = this.taskPath(taskId);
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Task;
    } catch {
      throw new Error(`Task ${taskId} not found`);
    }
  }

  private save(task: Task): void {
    writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2));
  }

  private clearDependency(completedId: number): void {
    for (const file of readdirSync(this.dir)) {
      if (!file.startsWith("task_") || !file.endsWith(".json")) continue;
      const task = JSON.parse(
        readFileSync(join(this.dir, file), "utf8"),
      ) as Task;
      if (task.blockedBy?.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        this.save(task);
      }
    }
  }

  create(subject: string, description = "", owner = ""): string {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: owner ? "in_progress" : "pending",
      owner,
      worktree: "",
      blockedBy: [],
      blocks: [],
    };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  exists(taskId: number): boolean {
    try {
      readFileSync(this.taskPath(taskId), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  update(
    taskId: number,
    status: TaskStatus | null = null,
    owner: string | null = null,
    addBlockedBy: number[] | null = null,
    addBlocks: number[] | null = null,
  ): string {
    const task = this.load(taskId);

    if (status) {
      task.status = status;
      if (status === "completed") this.clearDependency(taskId);
    }

    if (owner !== null) task.owner = owner;

    if (addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
      for (const blockerId of addBlockedBy) {
        const blocker = this.load(blockerId);
        if (!blocker.blocks.includes(taskId)) {
          blocker.blocks.push(taskId);
          this.save(blocker);
        }
      }
    }

    if (addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      for (const blockedId of addBlocks) {
        const blocked = this.load(blockedId);
        if (!blocked.blockedBy.includes(taskId)) {
          blocked.blockedBy.push(taskId);
          this.save(blocked);
        }
      }
    }

    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  /** 绑定任务到 worktree */
  bindWorktree(taskId: number, worktree: string, owner = ""): string {
    const task = this.load(taskId);
    task.worktree = worktree;
    if (owner) task.owner = owner;
    if (task.status === "pending") task.status = "in_progress";
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  /** 解绑 worktree */
  unbindWorktree(taskId: number): string {
    const task = this.load(taskId);
    task.worktree = "";
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  /** 扫描未认领的任务 */
  scanUnclaimed(): Task[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Task)
        .filter(
          (t) =>
            t.status === "pending" &&
            !t.owner &&
            (!t.blockedBy || !t.blockedBy.length),
        )
        .sort((a, b) => a.id - b.id);
    } catch {
      return [];
    }
  }

  /** 扫描分配给指定 owner 但尚未完成的任务 */
  scanAssigned(owner: string): Task[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Task)
        .filter(
          (t) =>
            t.owner === owner &&
            t.status !== "completed" &&
            (!t.blockedBy || !t.blockedBy.length),
        )
        .sort((a, b) => a.id - b.id);
    } catch {
      return [];
    }
  }

  /** 认领任务（带锁） */
  claimTask(taskId: number, owner: string): string {
    if (claimLock) return "Error: Claim in progress";
    claimLock = true;
    try {
      const task = this.load(taskId);
      if (task.owner) return `Error: Task #${taskId} already owned by ${task.owner}`;
      if (task.status !== "pending") return `Error: Task #${taskId} is ${task.status}`;
      task.owner = owner;
      task.status = "in_progress";
      this.save(task);
      return `Claimed task #${taskId} for ${owner}`;
    } finally {
      claimLock = false;
    }
  }

  listAll(): string {
    try {
      const tasks = readdirSync(this.dir)
        .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Task)
        .sort((a, b) => a.id - b.id);

      if (!tasks.length) return "No tasks.";

      return tasks
        .map((t) => {
          const marker = STATUS_MARKER[t.status] ?? "[?]";
          const owner = t.owner ? ` owner=${t.owner}` : "";
          const wt = t.worktree ? ` wt=${t.worktree}` : "";
          const blocked = t.blockedBy?.length
            ? ` (blocked by: ${t.blockedBy})`
            : "";
          return `${marker} #${t.id}: ${t.subject}${owner}${wt}${blocked}`;
        })
        .join("\n");
    } catch {
      return "No tasks.";
    }
  }
}

export const TASKS = new TaskManager(TASKS_DIR);
