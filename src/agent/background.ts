import { exec, ChildProcess } from "child_process";

const WORKDIR = process.cwd();
const debug = (...args: unknown[]) =>
  process.stderr.write(`[debug] ${args.join(" ")}\n`);

type TaskStatus = "running" | "completed" | "error" | "timeout";

interface BackgroundTask {
  status: TaskStatus;
  result: string | null;
  command: string;
  process: ChildProcess | null;
  /** true for long-running services (servers, watchers) */
  daemon: boolean;
}

interface Notification {
  task_id: string;
  status: TaskStatus;
  command: string;
  result: string;
}

export const BG_TOOL_SCHEMA = [
  {
    name: "background_run",
    description:
      "Run command in background. Returns task_id immediately. Set daemon=true for long-running services (servers, watchers) to disable timeout.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string" },
        daemon: {
          type: "boolean",
          description:
            "If true, the process runs indefinitely (no timeout). Use for servers/watchers.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "check_background",
    description: "Check background task status. Omit task_id to list all.",
    input_schema: {
      type: "object" as const,
      properties: { task_id: { type: "string" } },
    },
  },
  {
    name: "stop_background",
    description: "Stop a running background task by task_id.",
    input_schema: {
      type: "object" as const,
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
];

// 后台执行长时间命令，异步通知结果
class BackgroundManager {
  private tasks: Record<string, BackgroundTask> = {};
  private notificationQueue: Notification[] = [];

  // 后台运行命令
  run(command: string, daemon = false): string {
    const taskId = Math.random().toString(36).slice(2, 10);
    const timeout = daemon ? 0 : 300000; // daemon 模式不超时

    const child = exec(
      command,
      { cwd: WORKDIR, timeout, maxBuffer: 50000000 },
      (error, stdout, stderr) => {
        const output = (stdout + stderr).trim().slice(0, 50000);
        let status: TaskStatus;
        if (error) {
          status = error.killed ? "timeout" : "error";
          const errMsg = error.message?.slice(0, 200) || "unknown error";
          debug(`Background task ${taskId} ${status}: ${errMsg}`);
        } else {
          status = "completed";
          debug(`Background task ${taskId} completed`);
        }
        this.tasks[taskId].status = status;
        this.tasks[taskId].result = output || "(no output)";
        this.tasks[taskId].process = null;
        this.notificationQueue.push({
          task_id: taskId,
          status,
          command: command.slice(0, 80),
          result: (output || "(no output)").slice(0, 500),
        });
      },
    );

    this.tasks[taskId] = {
      status: "running",
      result: null,
      command,
      process: child,
      daemon,
    };
    debug(
      `Starting background task ${taskId}${daemon ? " (daemon)" : ""}: ${command.slice(0, 80)}`,
    );

    return `Background task ${taskId} started${daemon ? " (daemon, no timeout)" : ""}: ${command.slice(0, 80)}`;
  }

  // 检查后台任务状态
  check(taskId: string | null = null): string {
    if (taskId) {
      const t = this.tasks[taskId];
      if (!t) return `Error: Unknown task ${taskId}`;
      const label = t.daemon ? " [daemon]" : "";
      return `[${t.status}${label}] ${t.command.slice(0, 60)}\n${t.result ?? "(running)"}`;
    }
    const lines = Object.entries(this.tasks).map(
      ([tid, t]) => {
        const label = t.daemon ? " daemon" : "";
        return `${tid}: [${t.status}${label}] ${t.command.slice(0, 60)}`;
      },
    );
    return lines.length ? lines.join("\n") : "No background tasks.";
  }

  // 停止后台任务
  stop(taskId: string): string {
    const t = this.tasks[taskId];
    if (!t) return `Error: Unknown task ${taskId}`;
    if (t.status !== "running") return `Task ${taskId} is already ${t.status}`;
    if (t.process) {
      t.process.kill("SIGTERM");
      // Give it 3s to exit gracefully, then SIGKILL
      setTimeout(() => {
        if (t.status === "running" && t.process) {
          t.process.kill("SIGKILL");
        }
      }, 3000);
    }
    return `Sent SIGTERM to task ${taskId}`;
  }

  // 获取并清空通知队列
  drainNotifications(): Notification[] {
    const notifs = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifs;
  }
}

export const BG = new BackgroundManager();
