export type TaskStatus = "pending" | "in_progress" | "review" | "completed" | "failed" | "cancelled";

export interface TaskExecution {
  agentId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  result?: string;
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
  blockedBy: string[];
  blocks: string[];
  metadata?: Record<string, unknown>;
  execution?: TaskExecution;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  taskId: string;
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  addBlockedBy?: string[];
  addBlocks?: string[];
  metadata?: Record<string, unknown>;
  /** Runtime-owned execution record; deliberately absent from the model-facing TaskUpdate schema. */
  execution?: TaskExecution;
}

export interface TaskStore {
  create(input: CreateTaskInput): Promise<Task>;
  update(input: UpdateTaskInput): Promise<Task>;
  get(taskId: string): Task | null;
  list(): Task[];
  render(opts?: { activeOnly?: boolean }): string;
}
