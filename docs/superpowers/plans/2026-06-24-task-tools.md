# Tasks API (replace `todo`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-memory `todo` tool with a persistent four-tool Tasks API (`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`) backed by one JSON file per task, with bidirectional dependencies + cycle detection, cross-process file locking, and a per-turn reminder that re-injects the task list into the model request without persisting it.

**Architecture:** Everything lives in the **sdk** package; **core is untouched**. A `fileTaskStore` (lock + atomic-write, mirroring `fileSpillStore`/`jsonlStore`) is created in `createLiteAgent`, closed over by the four tool factories and by a `taskReminder` `wrapModelCall` middleware. Tasks persist under `~/.lite-agent/projects/<hash>/tasks/<listId>/<id>.json`, shared across sessions of a project.

**Tech Stack:** TypeScript 6 (ESM, strict), zod ^4, vitest, `proper-lockfile` (new dep) for the mutex.

---

## File structure

| Path | Responsibility | Action |
|---|---|---|
| `packages/sdk/src/tasks/types.ts` | `Task`, `TaskStatus`, input/store interfaces | Create |
| `packages/sdk/src/tasks/store.ts` | `fileTaskStore`: create/update/get/list/render, lock, atomic write, cycle detection | Create |
| `packages/sdk/src/tasks/reminder.ts` | `taskReminder` `wrapModelCall` middleware | Create |
| `packages/sdk/src/tools/task.ts` | The four `Task*` tools over a `TaskStore` | Create |
| `packages/sdk/src/paths.ts` | add `tasksDir` to `ProjectPaths` | Modify |
| `packages/sdk/src/tools/index.ts` | drop `todoTool` from `defaultTools` + export | Modify |
| `packages/sdk/src/tools/todo.ts` | the old tool | Delete |
| `packages/sdk/src/createLiteAgent.ts` | build store, register tools + reminder, new options | Modify |
| `packages/sdk/src/query.ts` | thread `tasks` / `taskListId` | Modify |
| `packages/sdk/src/system.ts` | task-planning guidance → `Task*` | Modify |
| `packages/sdk/src/index.ts` | export tasks API, drop `todoTool` | Modify |
| `packages/sdk/package.json` | add `proper-lockfile` (+ `@types`) | Modify |
| `packages/sdk/test/*` | new + updated tests | Create/Modify |

**Test command (run from repo root):** `pnpm --filter @lite-agent/sdk test -- <pattern>` (the `test` script is `vitest run`; the pattern filters by filename). Typecheck: `pnpm --filter @lite-agent/sdk typecheck`. No `core` rebuild is needed — sdk tests import sdk **source** directly and `@lite-agent/core` from its already-built `dist`.

---

## Task 1: `tasksDir` in paths

**Files:**
- Modify: `packages/sdk/src/paths.ts`
- Test: `packages/sdk/test/paths.test.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/sdk/test/paths.test.ts`:

```ts
test("resolveProjectPaths exposes a per-project tasksDir", () => {
  const { tasksDir, hash } = resolveProjectPaths({ workdir: "/some/proj", home: "/h" });
  expect(tasksDir).toBe(`/h/projects/${hash}/tasks`);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- paths`
Expected: FAIL — `tasksDir` is `undefined`.

- [ ] **Step 3: Implement** — in `packages/sdk/src/paths.ts`, add `tasksDir` to the interface and the returned object:

```ts
export interface ProjectPaths {
  home: string;
  hash: string;
  spillDir: string;
  sessionsDir: string;
  tasksDir: string;
  globalSkillsDir: string;
  projectSkillsDir: string;
}
```

Inside `resolveProjectPaths`, in the returned object literal add (next to `sessionsDir`):

```ts
    tasksDir: join(projectDir, "tasks"),
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @lite-agent/sdk test -- paths`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/paths.ts packages/sdk/test/paths.test.ts
git commit -m "feat(sdk): add per-project tasksDir to ProjectPaths"
```

---

## Task 2: data model + `fileTaskStore` create/get/list/render + persistence

**Files:**
- Create: `packages/sdk/src/tasks/types.ts`
- Create: `packages/sdk/src/tasks/store.ts`
- Create: `packages/sdk/test/tasks-store.test.ts`
- Modify: `packages/sdk/package.json` (add dep)

- [ ] **Step 1: Add the lock dependency** (run from repo root)

```bash
pnpm --filter @lite-agent/sdk add proper-lockfile
pnpm --filter @lite-agent/sdk add -D @types/proper-lockfile
```

Expected: `proper-lockfile` appears in `packages/sdk/package.json` `dependencies`, `@types/proper-lockfile` in `devDependencies`.

- [ ] **Step 2: Write `packages/sdk/src/tasks/types.ts`**

```ts
export type TaskStatus = "pending" | "in_progress" | "completed";

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
}

export interface TaskStore {
  create(input: CreateTaskInput): Promise<Task>;
  update(input: UpdateTaskInput): Promise<Task>;
  get(taskId: string): Task | null;
  list(): Task[];
  render(): string;
}
```

- [ ] **Step 3: Write the failing test** — `packages/sdk/test/tasks-store.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTaskStore } from "../src/tasks/store";

const newStore = () =>
  fileTaskStore({ dir: mkdtempSync(join(tmpdir(), "tasks-")), listId: "default" });

test("create allocates sequential ids and get/list read them back", async () => {
  const s = newStore();
  const a = await s.create({ subject: "first", description: "d1" });
  const b = await s.create({ subject: "second", description: "d2" });
  expect([a.id, b.id]).toEqual(["1", "2"]);
  expect(a.status).toBe("pending");
  expect(s.get("1")?.subject).toBe("first");
  expect(s.list().map((t) => t.id)).toEqual(["1", "2"]);
});

test("get returns null for an unknown id", async () => {
  expect(newStore().get("99")).toBeNull();
});

test("tasks persist across store instances on the same dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-"));
  await fileTaskStore({ dir, listId: "default" }).create({ subject: "kept", description: "d" });
  expect(fileTaskStore({ dir, listId: "default" }).get("1")?.subject).toBe("kept");
});

test("render shows a marker + status per task and empty string for none", async () => {
  const s = newStore();
  expect(s.render()).toBe("");
  await s.create({ subject: "build it", description: "d" });
  expect(s.render()).toContain("[ ] #1 build it (pending)");
});
```

- [ ] **Step 4: Run it, verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- tasks-store`
Expected: FAIL — cannot find `../src/tasks/store`.

- [ ] **Step 5: Write `packages/sdk/src/tasks/store.ts`** (create/get/list/render + lock + atomic write; `update`/cycle land in Task 3)

```ts
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
  const fileFor = (id: string) => join(dir, `${id}.json`);

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
```

> If the named import errors under the bundler, use `import lockfile from "proper-lockfile"; const { lock } = lockfile;`.

- [ ] **Step 6: Run it, verify it passes**

Run: `pnpm --filter @lite-agent/sdk test -- tasks-store`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/tasks/types.ts packages/sdk/src/tasks/store.ts packages/sdk/test/tasks-store.test.ts packages/sdk/package.json
git commit -m "feat(sdk): fileTaskStore create/get/list/render with lock + atomic writes"
```

---

## Task 3: `fileTaskStore.update` — fields, bidirectional deps, cycle detection

**Files:**
- Modify: `packages/sdk/src/tasks/store.ts`
- Test: `packages/sdk/test/tasks-store.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `packages/sdk/test/tasks-store.test.ts`:

```ts
test("update changes status and merges metadata", async () => {
  const s = newStore();
  await s.create({ subject: "x", description: "d" });
  const t = await s.update({ taskId: "1", status: "in_progress", metadata: { k: 1 } });
  expect(t.status).toBe("in_progress");
  expect(t.metadata).toEqual({ k: 1 });
  expect(s.get("1")?.status).toBe("in_progress");
});

test("addBlockedBy maintains both sides of the dependency", async () => {
  const s = newStore();
  await s.create({ subject: "a", description: "d" }); // #1
  await s.create({ subject: "b", description: "d" }); // #2
  await s.update({ taskId: "2", addBlockedBy: ["1"] });
  expect(s.get("2")?.blockedBy).toEqual(["1"]);
  expect(s.get("1")?.blocks).toEqual(["2"]);
});

test("update on an unknown task id throws", async () => {
  await expect(newStore().update({ taskId: "99", status: "completed" })).rejects.toThrow(/no task/);
});

test("a dependency edge that would create a cycle is rejected", async () => {
  const s = newStore();
  await s.create({ subject: "a", description: "d" }); // #1
  await s.create({ subject: "b", description: "d" }); // #2
  await s.update({ taskId: "2", addBlockedBy: ["1"] });          // 2 waits for 1
  await expect(s.update({ taskId: "1", addBlockedBy: ["2"] }))   // 1 waits for 2 → cycle
    .rejects.toThrow(/cycle/);
  expect(s.get("1")?.blockedBy).toEqual([]); // rejected → no partial write
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `pnpm --filter @lite-agent/sdk test -- tasks-store`
Expected: FAIL — `update` throws "not implemented".

- [ ] **Step 3: Implement `update` + a `hasCycle` helper.** In `packages/sdk/src/tasks/store.ts`, add this module-level function below `LOCK_OPTS`:

```ts
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
```

Replace the placeholder `update` with:

```ts
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
```

- [ ] **Step 4: Run them, verify they pass**

Run: `pnpm --filter @lite-agent/sdk test -- tasks-store`
Expected: PASS (8 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/tasks/store.ts packages/sdk/test/tasks-store.test.ts
git commit -m "feat(sdk): TaskStore.update with bidirectional deps + cycle detection"
```

---

## Task 4: concurrency — distinct ids under contention

**Files:**
- Test: `packages/sdk/test/tasks-store.test.ts`

- [ ] **Step 1: Write the failing/again-passing test** — append:

```ts
test("concurrent creates on the same dir get distinct ids (lock works)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-"));
  const a = fileTaskStore({ dir, listId: "default" });
  const b = fileTaskStore({ dir, listId: "default" });
  const results = await Promise.all([
    a.create({ subject: "from-a", description: "d" }),
    b.create({ subject: "from-b", description: "d" }),
  ]);
  expect(new Set(results.map((t) => t.id)).size).toBe(2);
  expect(a.list().length).toBe(2);
});
```

- [ ] **Step 2: Run it, verify it passes** (the lock from Task 2 already serializes id allocation; this test guards against regressions)

Run: `pnpm --filter @lite-agent/sdk test -- tasks-store`
Expected: PASS. If it flakes with a lock error, raise `LOCK_OPTS.retries.retries`.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/test/tasks-store.test.ts
git commit -m "test(sdk): concurrent task creates allocate distinct ids"
```

---

## Task 5: the four `Task*` tools

**Files:**
- Create: `packages/sdk/src/tools/task.ts`
- Create: `packages/sdk/test/task-tools.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/sdk/test/task-tools.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@lite-agent/core";
import { fileTaskStore } from "../src/tasks/store";
import { taskTools } from "../src/tools/task";

const ctx = { sessionId: "s", signal: new AbortController().signal, emit: () => {} } as ToolContext;
const tools = () => {
  const store = fileTaskStore({ dir: mkdtempSync(join(tmpdir(), "tt-")), listId: "default" });
  const map = new Map(taskTools(store).map((t) => [t.name, t]));
  return { store, map };
};

test("taskTools exposes the four tools by name", () => {
  expect([...tools().map.keys()].sort()).toEqual(["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]);
});

test("TaskCreate returns the new id; TaskList renders it", async () => {
  const { map } = tools();
  const created = await map.get("TaskCreate")!.execute({ subject: "build", description: "d" }, ctx);
  expect(created).toMatch(/#1/);
  const listed = await map.get("TaskList")!.execute({}, ctx);
  expect(listed).toContain("#1 build (pending)");
});

test("TaskUpdate advances status; TaskGet returns full detail", async () => {
  const { map } = tools();
  await map.get("TaskCreate")!.execute({ subject: "x", description: "d" }, ctx);
  await map.get("TaskUpdate")!.execute({ taskId: "1", status: "completed" }, ctx);
  const got = await map.get("TaskGet")!.execute({ taskId: "1" }, ctx);
  expect(got).toContain('"status": "completed"');
});

test("TaskGet on an unknown id reports it without throwing", async () => {
  const { map } = tools();
  expect(await map.get("TaskGet")!.execute({ taskId: "99" }, ctx)).toMatch(/No task/);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- task-tools`
Expected: FAIL — cannot find `../src/tools/task`.

- [ ] **Step 3: Write `packages/sdk/src/tools/task.ts`**

```ts
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";
import type { TaskStore } from "../tasks/types";

const STATUS = z.enum(["pending", "in_progress", "completed"]);
const META = z.record(z.string(), z.unknown()).optional();

export function taskTools(store: TaskStore): Tool[] {
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
    execute: async (input) => {
      const t = await store.create(input);
      return `Created task #${t.id}: ${t.subject}`;
    },
  });

  const update = defineTool({
    name: "TaskUpdate",
    description:
      "Update a task: set `status` (mark `completed` ONLY when fully accomplished — not on partial work or unresolved errors), edit fields, set `owner`, or add dependencies via `addBlockedBy`/`addBlocks`. A dependency that would form a cycle is rejected.",
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
    execute: async (input) => {
      const t = await store.update(input);
      return `Updated task #${t.id}: ${t.subject} (${t.status})`;
    },
  });

  const get = defineTool({
    name: "TaskGet",
    description: "Fetch the full detail of one task by id (description, status, dependency edges).",
    schema: z.object({ taskId: z.string() }),
    execute: ({ taskId }) => {
      const t = store.get(taskId);
      return t ? JSON.stringify(t, null, 2) : `No task '${taskId}'`;
    },
  });

  const list = defineTool({
    name: "TaskList",
    description: "List every task with its status and blockedBy dependencies.",
    schema: z.object({}),
    execute: () => store.render() || "No tasks.",
  });

  return [create, update, get, list];
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @lite-agent/sdk test -- task-tools`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/tools/task.ts packages/sdk/test/task-tools.test.ts
git commit -m "feat(sdk): TaskCreate/TaskUpdate/TaskGet/TaskList tools over TaskStore"
```

---

## Task 6: `taskReminder` per-turn re-injection middleware

**Files:**
- Create: `packages/sdk/src/tasks/reminder.ts`
- Create: `packages/sdk/test/reminder.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/sdk/test/reminder.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext, Message, ModelChunk } from "@lite-agent/core";
import { fileTaskStore } from "../src/tasks/store";
import { taskReminder } from "../src/tasks/reminder";

const mkCtx = (messages: Message[]): AgentContext =>
  ({ sessionId: "s", messages, turn: 1, signal: new AbortController().signal, emit: () => {}, state: new Map() });

const done: ModelChunk = {
  type: "message_done",
  message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  usage: { inputTokens: 0, outputTokens: 0 },
};

async function drive(mw: ReturnType<typeof taskReminder>, ctx: AgentContext) {
  let seen: Message[] = [];
  const next = async function* () {
    seen = [...ctx.messages]; // what encode would see
    yield done;
  };
  for await (const _ of mw.wrapModelCall!(ctx, next)) { /* consume */ }
  return seen;
}

test("injects the task list into the model's view but restores ctx.messages after", async () => {
  const store = fileTaskStore({ dir: mkdtempSync(join(tmpdir(), "rem-")), listId: "default" });
  await store.create({ subject: "do thing", description: "d" });
  const ctx = mkCtx([{ role: "user", content: "hi" }]);

  const seen = await drive(taskReminder(store), ctx);

  expect(seen.some((m) => String(m.content).includes("<system-reminder>"))).toBe(true);
  expect(seen.some((m) => String(m.content).includes("do thing"))).toBe(true);
  expect(ctx.messages).toHaveLength(1); // restored — reminder never lands in the transcript
});

test("does not inject anything when the task list is empty", async () => {
  const store = fileTaskStore({ dir: mkdtempSync(join(tmpdir(), "rem-")), listId: "default" });
  const ctx = mkCtx([{ role: "user", content: "hi" }]);
  const seen = await drive(taskReminder(store), ctx);
  expect(seen.some((m) => String(m.content).includes("system-reminder"))).toBe(false);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- reminder`
Expected: FAIL — cannot find `../src/tasks/reminder`.

- [ ] **Step 3: Write `packages/sdk/src/tasks/reminder.ts`**

```ts
import type { Middleware } from "@lite-agent/core";
import type { TaskStore } from "./types";

// Re-injects the current task list as a trailing <system-reminder> into the
// model request ONLY. wrapModelCall mutates ctx.messages just before encode and
// restores it in `finally`, so the reminder is never pushed onto the transcript
// or persisted. Place it innermost (last in the middleware array) so it sits
// closest to codec.encode.
export function taskReminder(store: TaskStore): Middleware {
  return {
    name: "task-reminder",
    async *wrapModelCall(ctx, next) {
      const block = store.render();
      if (!block) {
        yield* next();
        return;
      }
      const saved = ctx.messages;
      ctx.messages = [
        ...saved,
        { role: "user", content: `<system-reminder>\nCurrent tasks:\n${block}\n</system-reminder>` },
      ];
      try {
        yield* next();
      } finally {
        ctx.messages = saved;
      }
    },
  };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @lite-agent/sdk test -- reminder`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/tasks/reminder.ts packages/sdk/test/reminder.test.ts
git commit -m "feat(sdk): taskReminder wrapModelCall middleware (inject without persisting)"
```

---

## Task 7: wire into `createLiteAgent` / `query`, remove `todo`, update exports + system prompt + existing tests

**Files:**
- Modify: `packages/sdk/src/createLiteAgent.ts`
- Modify: `packages/sdk/src/query.ts`
- Modify: `packages/sdk/src/tools/index.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/system.ts`
- Delete: `packages/sdk/src/tools/todo.ts`
- Modify: `packages/sdk/test/tools.test.ts`
- Modify: `packages/sdk/test/system.test.ts`
- Modify: `packages/sdk/test/defaults.test.ts`

- [ ] **Step 1: Update the failing/changed tests first.**

In `packages/sdk/test/tools.test.ts`: remove the `import { todoTool } from "../src/tools/todo";` line, **delete** the entire `test("todo renders items and enforces a single in_progress", ...)` block, and change the built-ins test to drop `todo`:

```ts
test("defaultTools exposes the four built-ins by name", () => {
  const names = defaultTools(process.cwd())
    .map((t) => t.name)
    .sort();
  expect(names).toEqual(["bash", "edit_file", "read_file", "write_file"]);
});
```

In `packages/sdk/test/system.test.ts`, add an assertion to the existing test body:

```ts
  expect(s).toContain("TaskCreate");
```

In `packages/sdk/test/defaults.test.ts`, append:

```ts
test("task tools are registered by default; tasks:false removes them", async () => {
  const present = createLiteAgent({ model: callTool("TaskCreate", { subject: "x", description: "d" }), workdir: freshWorkdir() });
  expect(await toolResults(present)).toMatch(/Created task #1/);

  const off = createLiteAgent({ model: callTool("TaskCreate", { subject: "x", description: "d" }), workdir: freshWorkdir(), tasks: false });
  expect(await toolResults(off)).toMatch(/unknown tool/);
});

test("the per-turn task reminder is never persisted to the transcript", async () => {
  const workdir = freshWorkdir();
  const agent = createLiteAgent({
    model: callTool("TaskCreate", { subject: "persisted-subject", description: "d" }),
    workdir,
  });
  await agent.send("hi", { sessionId: "rem-sess" });
  const { sessionsDir } = resolveProjectPaths({ workdir, home: home() });
  const transcript = readFileSync(join(sessionsDir, "rem-sess.jsonl"), "utf8");
  expect(transcript).not.toContain("<system-reminder>");
});
```

Add `readFileSync` to the existing `node:fs` import at the top of `defaults.test.ts` (it currently imports `mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync`).

- [ ] **Step 2: Run the changed tests, verify they fail**

Run: `pnpm --filter @lite-agent/sdk test -- tools defaults system`
Expected: FAIL — `tasks` option unknown / `TaskCreate` is an unknown tool / prompt lacks "TaskCreate" / todo import missing.

- [ ] **Step 3: Remove `todo` from the tool registry.** In `packages/sdk/src/tools/index.ts` replace the whole file with:

```ts
import type { Tool } from "@lite-agent/core";
import { bashTool } from "./bash";
import { fileTools } from "./file";

export function defaultTools(workdir: string): Tool[] {
  return [bashTool(workdir), ...fileTools(workdir)];
}

export { bashTool } from "./bash";
export { fileTools, makeSafePath } from "./file";
export { askUserTool } from "./askUser";
export { taskTools } from "./task";
```

- [ ] **Step 4: Delete the old tool**

```bash
git rm packages/sdk/src/tools/todo.ts
```

- [ ] **Step 5: Update `packages/sdk/src/system.ts`** — replace the `## Task Planning` block:

```ts
## Task Planning
- For any task with 3+ steps, call TaskCreate to capture each step before executing.
- Call TaskUpdate to set a task in_progress before starting it and completed only when fully done; use TaskList/TaskGet to review state.
```

(Replace the two old `- For any task… todo …` / `- Mark todos …` bullet lines with the two lines above.)

- [ ] **Step 6: Wire the store, tools, reminder, and options into `packages/sdk/src/createLiteAgent.ts`.**

Add imports near the other tool imports:

```ts
import { fileTaskStore } from "./tasks/store";
import { taskTools } from "./tools/task";
import { taskReminder } from "./tasks/reminder";
```

Add two options to `CreateLiteAgentConfig` (next to `spill`):

```ts
  /** Persistent Tasks API (TaskCreate/Update/Get/List) + per-turn reminder. Default true. */
  tasks?: boolean;
  /** Task-list id under tasksDir. Default `$LITE_AGENT_TASK_LIST_ID` || "default". */
  taskListId?: string;
```

After the spill block (`if (spillStore) tools.push(readSpilledTool(spillStore));`) and before `if (cfg.tools) tools.push(...cfg.tools);`, add:

```ts
  // Persistent Tasks API: store closed over by the four tools + the reminder.
  const tasksEnabled = cfg.tasks !== false;
  const taskStore = tasksEnabled
    ? fileTaskStore({
        dir: paths.tasksDir,
        listId: cfg.taskListId ?? process.env.LITE_AGENT_TASK_LIST_ID ?? "default",
      })
    : undefined;
  if (taskStore) tools.push(...taskTools(taskStore));
```

In the `use` array, add the reminder as the **last** entry (innermost, closest to encode):

```ts
  const use: Middleware[] = [
    ...(compactor ? [compaction(compactor), reactiveCompaction()] : []),
    ...(cfg.permission ? [permission(cfg.permission, cfg.onApproval)] : []),
    ...(cfg.use ?? []),
    ...(taskStore ? [taskReminder(taskStore)] : []),
  ];
```

- [ ] **Step 7: Thread the options through `packages/sdk/src/query.ts`.** Add to `QueryOptions` (next to `spill`):

```ts
  tasks?: boolean;
  taskListId?: string;
```

And in the `createLiteAgent({ ... })` call inside `query`, add:

```ts
    tasks: opts.tasks,
    taskListId: opts.taskListId,
```

- [ ] **Step 8: Fix `packages/sdk/src/index.ts` exports.** In the `from "./tools"` re-export block, remove the `todoTool,` line. Then add new exports:

```ts
export { taskTools } from "./tools";
export { fileTaskStore } from "./tasks/store";
export type { FileTaskStoreOptions } from "./tasks/store";
export { taskReminder } from "./tasks/reminder";
export type { Task, TaskStatus, TaskStore, CreateTaskInput, UpdateTaskInput } from "./tasks/types";
```

- [ ] **Step 9: Run the full sdk suite + typecheck**

Run: `pnpm --filter @lite-agent/sdk test`
Expected: PASS (all files, including the updated `tools`/`defaults`/`system`).

Run: `pnpm --filter @lite-agent/sdk typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add -A packages/sdk
git commit -m "feat(sdk): replace todo tool with persistent Tasks API + per-turn reminder"
```

---

## Task 8: changeset + full-workspace verification

**Files:**
- Create: `.changeset/<name>.md`

- [ ] **Step 1: Write the changeset** — create `.changeset/task-tools.md`:

```md
---
"lite-agent": minor
"@lite-agent/core": minor
"@lite-agent/provider": minor
"@lite-agent/sandbox-anthropic": minor
---

Replace the in-memory `todo` tool with a persistent Tasks API (`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`): one JSON file per task under `tasks/<listId>/`, bidirectional dependencies with cycle detection, cross-process file locking, and a per-turn `<system-reminder>` that re-injects the current task list without persisting it. New `createLiteAgent`/`query` options `tasks` (default on) and `taskListId`.
```

> Confirm the four package names/keys against an existing file in `.changeset/` before writing (the repo fixes all four to one version).

- [ ] **Step 2: Full build → test → typecheck (topological)**

Run: `pnpm -r build && pnpm -r test && pnpm -r typecheck`
Expected: all packages PASS. (`provider`/`sandbox-anthropic`/example don't depend on the task changes; this confirms nothing else broke.)

- [ ] **Step 3: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for Tasks API replacing the todo tool"
```

---

## Self-review notes (author)

- **Spec coverage:** data model → T2/T3; per-task JSON + per-project path + list-id → T1/T2/T7; bidirectional deps + cycle detection → T3; concurrency (proper-lockfile + atomic write) → T2/T4; four tools w/ verbatim-style guidance → T5; per-turn reminder via `wrapModelCall`, never persisted → T6 + the T7 transcript test; remove `todo`, default-on `tasks` + `taskListId`, query threading, system prompt → T7; "drop single in_progress" → realized by simply not porting that check; changeset/behavior-change → T8.
- **Out-of-scope held out:** the subagent dispatcher, `tasksDir` cleanup, `TaskDelete`, network-FS locking — none appear as tasks.
- **Type consistency:** `TaskStore` methods (`create/update/get/list/render`) and `Task`/`CreateTaskInput`/`UpdateTaskInput` field names are used identically across store, tools, reminder, and exports. `fileTaskStore({ dir, listId })` signature matches every call site (tests + createLiteAgent).
- **Ordering caveat called out:** reminder must be the last middleware (innermost) — encoded request includes it, transcript does not.
