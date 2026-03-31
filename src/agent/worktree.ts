import { execSync } from "child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import { dirname, join, resolve } from "path";

const debug = (...args: unknown[]) =>
  process.stderr.write(`[debug:worktree] ${args.join(" ")}\n`);

// --- EventBus: JSONL event log for worktree lifecycle ---

interface WorktreeEvent {
  event: string;
  ts: number;
  task: Record<string, unknown>;
  worktree: Record<string, unknown>;
  error?: string;
}

class EventBus {
  private path: string;

  constructor(eventLogPath: string) {
    this.path = eventLogPath;
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) writeFileSync(this.path, "");
  }

  emit(
    event: string,
    task: Record<string, unknown> = {},
    worktree: Record<string, unknown> = {},
    error: string | null = null,
  ): void {
    const payload: WorktreeEvent = { event, ts: Date.now(), task, worktree };
    if (error) payload.error = error;
    appendFileSync(this.path, JSON.stringify(payload) + "\n");
  }

  listRecent(limit = 20): string {
    const n = Math.max(1, Math.min(limit, 200));
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    return JSON.stringify(
      lines.slice(-n).map((l) => JSON.parse(l) as WorktreeEvent),
      null,
      2,
    );
  }
}

// --- WorktreeManager: git worktree lifecycle ---

interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  task_id: number | null;
  status: "active" | "removed" | "kept";
  created_at: number;
  removed_at?: number;
  kept_at?: number;
}

interface WorktreeIndex {
  worktrees: WorktreeEntry[];
}

function detectRepoRoot(cwd: string): string {
  try {
    return resolve(
      execSync("git rev-parse --show-toplevel", {
        cwd,
        encoding: "utf8",
        timeout: 10000,
      }).trim(),
    );
  } catch {
    return cwd;
  }
}

class WorktreeManager {
  private repoRoot: string;
  private dir: string;
  private indexPath: string;
  private events: EventBus;
  gitAvailable: boolean;

  constructor(repoRoot: string, events: EventBus) {
    this.repoRoot = repoRoot;
    this.events = events;
    this.dir = join(repoRoot, ".worktrees");
    mkdirSync(this.dir, { recursive: true });
    this.indexPath = join(this.dir, "index.json");
    if (!existsSync(this.indexPath))
      writeFileSync(
        this.indexPath,
        JSON.stringify({ worktrees: [] }, null, 2),
      );
    this.gitAvailable = this._isGitRepo();
  }

  private _isGitRepo(): boolean {
    try {
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: this.repoRoot,
        encoding: "utf8",
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private _runGit(args: string[]): string {
    if (!this.gitAvailable) throw new Error("Not in a git repository");
    return (
      execSync(`git ${args.join(" ")}`, {
        cwd: this.repoRoot,
        encoding: "utf8",
        timeout: 120000,
      }).trim() || "(no output)"
    );
  }

  private _loadIndex(): WorktreeIndex {
    return JSON.parse(readFileSync(this.indexPath, "utf8")) as WorktreeIndex;
  }

  private _saveIndex(data: WorktreeIndex): void {
    writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
  }

  private _find(name: string): WorktreeEntry | undefined {
    return this._loadIndex().worktrees.find((wt) => wt.name === name);
  }

  create(name: string, taskId: number | null = null, baseRef = "HEAD"): string {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name))
      throw new Error("Invalid worktree name");
    if (this._find(name)) throw new Error(`Worktree '${name}' already exists`);

    const path = join(this.dir, name);
    const branch = `wt/${name}`;
    debug(`Creating worktree '${name}' from ${baseRef}`);
    this.events.emit(
      "worktree.create.before",
      taskId !== null ? { id: taskId } : {},
      { name, base_ref: baseRef },
    );

    try {
      this._runGit(["worktree", "add", "-b", branch, path, baseRef]);
      const entry: WorktreeEntry = {
        name,
        path,
        branch,
        task_id: taskId,
        status: "active",
        created_at: Date.now(),
      };
      const idx = this._loadIndex();
      idx.worktrees.push(entry);
      this._saveIndex(idx);
      this.events.emit(
        "worktree.create.after",
        taskId !== null ? { id: taskId } : {},
        { name, path, branch, status: "active" },
      );
      return JSON.stringify(entry, null, 2);
    } catch (e: any) {
      this.events.emit(
        "worktree.create.failed",
        taskId !== null ? { id: taskId } : {},
        { name, base_ref: baseRef },
        e.message,
      );
      throw e;
    }
  }

  listAll(): string {
    const idx = this._loadIndex();
    const wts = idx.worktrees || [];
    if (!wts.length) return "No worktrees in index.";
    return wts
      .map((wt) => {
        const suffix = wt.task_id ? ` task=${wt.task_id}` : "";
        return `[${wt.status || "unknown"}] ${wt.name} -> ${wt.path} (${wt.branch || "-"})${suffix}`;
      })
      .join("\n");
  }

  status(name: string): string {
    const wt = this._find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    if (!existsSync(wt.path))
      return `Error: Worktree path missing: ${wt.path}`;
    try {
      return (
        execSync("git status --short --branch", {
          cwd: wt.path,
          encoding: "utf8",
          timeout: 60000,
        }).trim() || "Clean worktree"
      );
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  run(name: string, command: string): string {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d)))
      return "Error: Dangerous command blocked";
    const wt = this._find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    if (!existsSync(wt.path))
      return `Error: Worktree path missing: ${wt.path}`;
    try {
      return (
        execSync(command, {
          cwd: wt.path,
          encoding: "utf8",
          timeout: 300000,
          maxBuffer: 50000000,
        })
          .trim()
          .slice(0, 50000) || "(no output)"
      );
    } catch (e: any) {
      return (
        ((e.stdout || "") + (e.stderr || "")).trim().slice(0, 50000) ||
        `Error: ${e.message}`
      );
    }
  }

  remove(name: string, force = false, completeTask = false): string {
    const wt = this._find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    debug(`Removing worktree '${name}' (force=${force})`);

    try {
      const args = ["worktree", "remove"];
      if (force) args.push("--force");
      args.push(wt.path);
      this._runGit(args);

      const idx = this._loadIndex();
      const item = idx.worktrees.find((w) => w.name === name);
      if (item) {
        item.status = "removed";
        item.removed_at = Date.now();
      }
      this._saveIndex(idx);
      this.events.emit(
        "worktree.remove.after",
        wt.task_id !== null ? { id: wt.task_id } : {},
        { name, path: wt.path, status: "removed" },
      );
      return `Removed worktree '${name}'${completeTask && wt.task_id !== null ? ` (task #${wt.task_id})` : ""}`;
    } catch (e: any) {
      this.events.emit(
        "worktree.remove.failed",
        wt.task_id !== null ? { id: wt.task_id } : {},
        { name, path: wt.path },
        e.message,
      );
      return `Error: ${e.message}`;
    }
  }

  keep(name: string): string {
    const wt = this._find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    const idx = this._loadIndex();
    const item = idx.worktrees.find((w) => w.name === name);
    if (item) {
      item.status = "kept";
      item.kept_at = Date.now();
    }
    this._saveIndex(idx);
    this.events.emit(
      "worktree.keep",
      wt.task_id !== null ? { id: wt.task_id } : {},
      { name, path: wt.path, status: "kept" },
    );
    return JSON.stringify(item, null, 2);
  }

  getPath(name: string): string | null {
    const wt = this._find(name);
    return wt?.path ?? null;
  }
}

// --- Singletons ---

const WORKDIR = process.cwd();
const REPO_ROOT = detectRepoRoot(WORKDIR);
const EVENTS = new EventBus(join(REPO_ROOT, ".worktrees", "events.jsonl"));
const WORKTREES = new WorktreeManager(REPO_ROOT, EVENTS);

// --- Tool schemas (lead-side) ---

export const WORKTREE_SCHEMA = [
  {
    name: "worktree_create",
    description: "Create a git worktree for isolated work.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        task_id: { type: "integer" },
        base_ref: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "worktree_list",
    description: "List all worktrees.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "worktree_status",
    description: "Show git status for a worktree.",
    input_schema: {
      type: "object" as const,
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "worktree_run",
    description: "Run a command inside a worktree directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        command: { type: "string" },
      },
      required: ["name", "command"],
    },
  },
  {
    name: "worktree_remove",
    description: "Remove a worktree.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        force: { type: "boolean" },
        complete_task: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "worktree_keep",
    description: "Mark a worktree as kept (preserved).",
    input_schema: {
      type: "object" as const,
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "worktree_events",
    description: "List recent worktree events.",
    input_schema: {
      type: "object" as const,
      properties: { limit: { type: "integer" } },
    },
  },
];

export { WORKTREES, EVENTS, REPO_ROOT };
