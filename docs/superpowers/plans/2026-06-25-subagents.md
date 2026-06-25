# Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add file-defined subagents (`agents/*.md`) dispatched by the main agent through a single parallel-capable `Agent` tool, with each subagent run persisted to disk and resumable.

**Architecture:** All code lives in the **sdk** package; **core is untouched**. An `AgentLoader` (twin of `SkillLoader`) reads `.md` definitions from global + project + optional dirs. A batch `Agent` tool runs N child kernels concurrently (bounded pool) by re-invoking `createLiteAgent` per child with isolated context (`[{role:"user",content:prompt}]`), returning each child's final text. Persistence is the existing `jsonlStore`; resume is the kernel's existing `store.load(sessionId)` prepend.

**Tech Stack:** TypeScript 6 (strict ESM, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), zod v4, gray-matter, vitest, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-06-25-subagents-design.md`

**Conventions for every task:**
- Run tests with `pnpm --filter @lite-agent/sdk test -- <name>` (vitest filters by file path substring). Run the whole sdk suite with `pnpm --filter @lite-agent/sdk test`.
- No core rebuild needed: new sdk files import `@lite-agent/core` from its already-built `dist`, and sdk tests import sdk modules via relative `../src/...`.
- Match existing style: `import type` for type-only imports; 2-space indent; `defineTool` for tools.

---

### Task 1: Add agent directories to `paths.ts`

**Files:**
- Modify: `packages/sdk/src/paths.ts`
- Test: `packages/sdk/test/paths.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/sdk/test/paths.test.ts`:

```ts
test("resolveProjectPaths derives global and project agent dirs", () => {
  const p = resolveProjectPaths({ workdir: "/tmp/proj", home: "/tmp/home" });
  expect(p.globalAgentsDir).toBe("/tmp/home/agents");
  expect(p.projectAgentsDir).toBe("/tmp/proj/.lite-agent/agents");
});
```

(If `resolveProjectPaths` is not yet imported in that file, add it to the existing import from `../src/paths`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- paths`
Expected: FAIL — `globalAgentsDir`/`projectAgentsDir` are `undefined`.

- [ ] **Step 3: Implement**

In `packages/sdk/src/paths.ts`, add two fields to the `ProjectPaths` interface (after `projectSkillsDir`):

```ts
  globalAgentsDir: string;
  projectAgentsDir: string;
```

And in the object returned by `resolveProjectPaths` (after `projectSkillsDir`):

```ts
    globalAgentsDir: join(home, "agents"),
    projectAgentsDir: join(resolve(opts.workdir), ".lite-agent", "agents"),
```

`join` and `resolve` are already imported in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lite-agent/sdk test -- paths`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/paths.ts packages/sdk/test/paths.test.ts
git commit -m "feat(sdk): add global/project agent dirs to ProjectPaths"
```

---

### Task 2: `AgentLoader` + `AgentDefinition`

**Files:**
- Create: `packages/sdk/src/agents/types.ts`
- Create: `packages/sdk/src/agents/loader.ts`
- Test: `packages/sdk/test/agents-loader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/agents-loader.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoader } from "../src/agents/loader";

const dir = () => mkdtempSync(join(tmpdir(), "agents-"));

test("loads name, description, model and body from a .md file", () => {
  const d = dir();
  writeFileSync(
    join(d, "researcher.md"),
    "---\nname: researcher\ndescription: digs through code\nmodel: gpt-x\n---\nYou are a researcher.",
  );
  const loader = new AgentLoader(d);
  const def = loader.get("researcher")!;
  expect(def.description).toBe("digs through code");
  expect(def.model).toBe("gpt-x");
  expect(def.body).toBe("You are a researcher.");
  expect(loader.getDescriptions()).toContain("researcher: digs through code");
});

test("name falls back to the filename when frontmatter omits it", () => {
  const d = dir();
  writeFileSync(join(d, "reviewer.md"), "---\ndescription: reviews\n---\nBody");
  expect(new AgentLoader(d).names()).toEqual(["reviewer"]);
});

test("a later dir overrides an earlier dir on name collision", () => {
  const a = dir();
  const b = dir();
  writeFileSync(join(a, "x.md"), "---\nname: x\ndescription: from A\n---\nA BODY");
  writeFileSync(join(b, "x.md"), "---\nname: x\ndescription: from B\n---\nB BODY");
  const loader = new AgentLoader([a, b]);
  expect(loader.get("x")!.body).toBe("B BODY");
  expect(loader.get("x")!.description).toBe("from B");
});

test("tools parse from a YAML list", () => {
  const d = dir();
  writeFileSync(join(d, "a.md"), "---\nname: a\ndescription: d\ntools:\n  - bash\n  - read_file\n---\nB");
  expect(new AgentLoader(d).get("a")!.tools).toEqual(["bash", "read_file"]);
});

test("tools parse from a comma-separated string", () => {
  const d = dir();
  writeFileSync(join(d, "a.md"), "---\nname: a\ndescription: d\ntools: bash, read_file\n---\nB");
  expect(new AgentLoader(d).get("a")!.tools).toEqual(["bash", "read_file"]);
});

test("missing tools yields undefined (inherit)", () => {
  const d = dir();
  writeFileSync(join(d, "a.md"), "---\nname: a\ndescription: d\n---\nB");
  expect(new AgentLoader(d).get("a")!.tools).toBeUndefined();
});

test("unknown get returns null; empty loader reports a placeholder", () => {
  const loader = new AgentLoader(join(tmpdir(), "missing-agents-xyz"));
  expect(loader.get("nope")).toBeNull();
  expect(loader.names()).toEqual([]);
  expect(loader.getDescriptions()).toBe("(no subagents available)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- agents-loader`
Expected: FAIL — cannot resolve `../src/agents/loader`.

- [ ] **Step 3: Implement the types**

Create `packages/sdk/src/agents/types.ts`:

```ts
export interface AgentDefinition {
  /** From frontmatter `name`, else the filename (sans `.md`). */
  name: string;
  /** When to use this subagent — surfaced to the main agent. */
  description: string;
  /** Allow-list of tool names; absent = inherit the parent's tool set. */
  tools?: string[];
  /** Override the request-time model id (reuses the same ModelProvider). */
  model?: string;
  /** The subagent's system prompt. */
  body: string;
  /** Source file path (diagnostics). */
  path: string;
}
```

- [ ] **Step 4: Implement the loader**

Create `packages/sdk/src/agents/loader.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import matter from "gray-matter";
import type { AgentDefinition } from "./types";

interface Frontmatter {
  name?: string;
  description?: string;
  tools?: string | string[];
  model?: string;
  [k: string]: unknown;
}

export class AgentLoader {
  readonly dirs: string[];
  private agents: Record<string, AgentDefinition> = {};

  constructor(dirs: string | string[]) {
    this.dirs = Array.isArray(dirs) ? dirs : [dirs];
    this.loadAll();
  }

  private loadAll(): void {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".md")) this.add(p);
      }
    };
    // Walk in order; later dirs overwrite earlier ones on name collision.
    for (const dir of this.dirs) if (existsSync(dir)) walk(dir);
  }

  private add(path: string): void {
    const { data, content } = matter(readFileSync(path, "utf8"));
    const fm = data as Frontmatter;
    const name = fm.name ?? basename(path).replace(/\.md$/, "");
    this.agents[name] = {
      name,
      description: fm.description ?? "No description",
      tools: normalizeTools(fm.tools),
      model: fm.model,
      body: content.trim(),
      path,
    };
  }

  names(): string[] {
    return Object.keys(this.agents);
  }

  list(): AgentDefinition[] {
    return Object.values(this.agents);
  }

  get(name: string): AgentDefinition | null {
    return this.agents[name] ?? null;
  }

  getDescriptions(): string {
    const names = this.names();
    if (!names.length) return "(no subagents available)";
    return names.map((n) => `  - ${n}: ${this.agents[n]!.description}`).join("\n");
  }
}

function normalizeTools(raw: string | string[] | undefined): string[] | undefined {
  if (raw == null) return undefined;
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const cleaned = list.map((s) => s.trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @lite-agent/sdk test -- agents-loader`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/agents/ packages/sdk/test/agents-loader.test.ts
git commit -m "feat(sdk): AgentLoader reads agent definitions from .md files"
```

---

### Task 3: The `Agent` tool (batch + bounded-parallel dispatch)

**Files:**
- Create: `packages/sdk/src/tools/agent.ts`
- Test: `packages/sdk/test/agent-tool.test.ts`

The tool closes over an injected `spawn` (the real one is built in Task 4). Tests inject a fake `spawn` and a real `AgentLoader` built from a tmp dir.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/agent-tool.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@lite-agent/core";
import { AgentLoader } from "../src/agents/loader";
import { agentTool } from "../src/tools/agent";
import type { Spawn } from "../src/tools/agent";

const ctx: ToolContext = {
  sessionId: "s",
  signal: new AbortController().signal,
  emit: () => {},
};

function loaderWith(...names: string[]): AgentLoader {
  const d = mkdtempSync(join(tmpdir(), "at-"));
  for (const n of names)
    writeFileSync(join(d, `${n}.md`), `---\nname: ${n}\ndescription: ${n} agent\n---\n${n} body`);
  return new AgentLoader(d);
}

test("unknown subagent_type is reported but does not fail the batch", async () => {
  const spawn: Spawn = async () => "ran";
  const tool = agentTool({ loader: loaderWith("known"), spawn });
  const out = await tool.execute(
    { tasks: [{ subagent_type: "ghost", prompt: "x" }, { subagent_type: "known", prompt: "y" }] },
    ctx,
  );
  expect(out).toMatch(/unknown subagent_type 'ghost'/);
  expect(out).toContain("Available: known");
  expect(out).toContain("ran");
});

test("a single task returns the child's final text attributed with its agentId", async () => {
  const spawn: Spawn = async () => "child result";
  const tool = agentTool({ loader: loaderWith("worker"), spawn });
  const out = await tool.execute({ tasks: [{ subagent_type: "worker", prompt: "go" }] }, ctx);
  expect(out).toContain("child result");
  expect(out).toMatch(/agentId: agent-worker-[0-9a-f]{8}/);
});

test("isolation: spawn receives exactly the task prompt", async () => {
  let seen = "";
  const spawn: Spawn = async (_def, prompt) => { seen = prompt; return "ok"; };
  const tool = agentTool({ loader: loaderWith("worker"), spawn });
  await tool.execute({ tasks: [{ subagent_type: "worker", prompt: "ONLY THIS" }] }, ctx);
  expect(seen).toBe("ONLY THIS");
});

test("resume reuses the supplied agentId as the session id", async () => {
  let seenSession = "";
  const spawn: Spawn = async (_def, _prompt, opts) => { seenSession = opts.sessionId; return "ok"; };
  const tool = agentTool({ loader: loaderWith("worker"), spawn });
  const out = await tool.execute(
    { tasks: [{ subagent_type: "worker", prompt: "go", resume: "agent-worker-deadbeef" }] },
    ctx,
  );
  expect(seenSession).toBe("agent-worker-deadbeef");
  expect(out).toContain("agentId: agent-worker-deadbeef");
});

test("parallel: every task runs and results are aggregated in order", async () => {
  const calls: string[] = [];
  const spawn: Spawn = async (def, prompt) => { calls.push(def.name); return `${def.name}:${prompt}`; };
  const tool = agentTool({ loader: loaderWith("a", "b", "c"), spawn });
  const out = await tool.execute(
    { tasks: [
      { subagent_type: "a", prompt: "1" },
      { subagent_type: "b", prompt: "2" },
      { subagent_type: "c", prompt: "3" },
    ] },
    ctx,
  );
  expect(calls.sort()).toEqual(["a", "b", "c"]);
  expect(out.indexOf("a:1")).toBeLessThan(out.indexOf("b:2"));
  expect(out.indexOf("b:2")).toBeLessThan(out.indexOf("c:3"));
});

test("one task throwing surfaces its error; siblings still succeed", async () => {
  const spawn: Spawn = async (def) => {
    if (def.name === "bad") throw new Error("boom");
    return "fine";
  };
  const tool = agentTool({ loader: loaderWith("good", "bad"), spawn });
  const out = await tool.execute(
    { tasks: [{ subagent_type: "good", prompt: "x" }, { subagent_type: "bad", prompt: "y" }] },
    ctx,
  );
  expect(out).toContain("fine");
  expect(out).toMatch(/Error: boom/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- agent-tool`
Expected: FAIL — cannot resolve `../src/tools/agent`.

- [ ] **Step 3: Implement**

Create `packages/sdk/src/tools/agent.ts`:

```ts
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";
import type { AgentLoader } from "../agents/loader";
import type { AgentDefinition } from "../agents/types";

/** Upper bound on concurrent child kernels per `Agent` call. */
const MAX_CONCURRENCY = 5;

export interface SpawnOptions {
  signal: AbortSignal;
  sessionId: string;
}
export type Spawn = (
  def: AgentDefinition,
  prompt: string,
  opts: SpawnOptions,
) => Promise<string>;

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
const shortId = () => randomBytes(4).toString("hex");

const TASK = z.object({
  subagent_type: z.string(),
  prompt: z.string(),
  description: z.string().optional(),
  resume: z.string().optional(),
});

export function agentTool(opts: { loader: AgentLoader; spawn: Spawn }): Tool {
  const { loader, spawn } = opts;
  return defineTool({
    name: "Agent",
    description:
      "Delegate a large or context-heavy subtask to a specialized subagent, keeping your own context clean. Each subagent runs in isolation (it sees only the `prompt` you pass) and returns only its final result. Pass MULTIPLE entries in `tasks` to run independent subtasks in parallel. To continue a previous subagent, pass its reported agentId as `resume`.",
    schema: z.object({ tasks: z.array(TASK).min(1) }),
    execute: async ({ tasks }, ctx) => {
      const runOne = async (t: z.infer<typeof TASK>): Promise<{ id: string; out: string }> => {
        const def = loader.get(t.subagent_type);
        if (!def) {
          return {
            id: "-",
            out: `Error: unknown subagent_type '${t.subagent_type}'. Available: ${
              loader.names().join(", ") || "(none)"
            }`,
          };
        }
        const sessionId = t.resume ?? `agent-${sanitize(t.subagent_type)}-${shortId()}`;
        try {
          const out = await spawn(def, t.prompt, { signal: ctx.signal, sessionId });
          return { id: sessionId, out };
        } catch (e) {
          return { id: sessionId, out: `Error: ${(e as Error).message}` };
        }
      };

      const results = await runPool(tasks, MAX_CONCURRENCY, runOne);
      return results
        .map((r, i) => `## subagent[${i}] ${tasks[i]!.subagent_type} (agentId: ${r.id})\n${r.out}`)
        .join("\n\n");
    },
  });
}

/** Run `fn` over `items` with at most `limit` in flight; results stay input-ordered. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lite-agent/sdk test -- agent-tool`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/tools/agent.ts packages/sdk/test/agent-tool.test.ts
git commit -m "feat(sdk): Agent tool — batch, bounded-parallel subagent dispatch"
```

---

### Task 4: Wire subagents into `createLiteAgent`, `query`, `system`, exports

**Files:**
- Modify: `packages/sdk/src/system.ts`
- Modify: `packages/sdk/src/createLiteAgent.ts`
- Modify: `packages/sdk/src/query.ts`
- Modify: `packages/sdk/src/tools/index.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/system.test.ts` (add), `packages/sdk/test/subagents.test.ts` (new)

- [ ] **Step 1: Write the failing system-prompt test**

Add to `packages/sdk/test/system.test.ts`:

```ts
test("includes a Subagents section listing types when subagents are provided", () => {
  const prompt = buildSystemPrompt({
    workdir: "/w",
    skills: "(no skills available)",
    subagents: "  - researcher: digs through code",
  });
  expect(prompt).toContain("## Subagents");
  expect(prompt).toContain("researcher: digs through code");
});

test("omits the Subagents section when none are available", () => {
  const prompt = buildSystemPrompt({
    workdir: "/w",
    skills: "(no skills available)",
    subagents: "(no subagents available)",
  });
  expect(prompt).not.toContain("## Subagents");
});
```

(Ensure `buildSystemPrompt` is imported from `../src/system` in this file.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- system`
Expected: FAIL — `subagents` not an accepted option / no `## Subagents` section.

- [ ] **Step 3: Implement `system.ts`**

In `packages/sdk/src/system.ts`, add `subagents` to the options and append a section.

Replace the interface:

```ts
export interface SystemPromptOptions {
  workdir: string;
  modelName?: string;
  skills: string;
  subagents?: string;
}
```

In `buildSystemPrompt`, before the `return`, add:

```ts
  const subagentsSection =
    opts.subagents && opts.subagents !== "(no subagents available)"
      ? `\n\n## Subagents
For large or context-heavy subtasks, delegate to a specialized subagent via the \`Agent\` tool instead of doing the work inline — this keeps your own context clean. To run independent subtasks in parallel, pass multiple entries in a single \`Agent\` call.
Available subagents:
${opts.subagents}`
      : "";
```

Then append `${subagentsSection}` to the very end of the returned template string (after the `${opts.skills}` line):

```ts
${opts.skills}${subagentsSection}`;
```

- [ ] **Step 4: Run to verify system tests pass**

Run: `pnpm --filter @lite-agent/sdk test -- system`
Expected: PASS

- [ ] **Step 5: Write the failing wiring tests**

Create `packages/sdk/test/subagents.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { resolveProjectPaths } from "../src/paths";
import { fileTaskStore } from "../src/tasks/store";

function agentsDir(name: string, body = `${name} body`): string {
  const d = mkdtempSync(join(tmpdir(), "sa-"));
  writeFileSync(join(d, `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\n---\n${body}`);
  return d;
}

// One fakeProvider instance is shared by parent and child kernels; its turn counter
// advances once per model call, so turns run in deterministic order:
// parent-turn1 (Agent call) -> child-turn1 -> parent-turn2.
function collectResults(gen: AsyncGenerator<{ type: string }, unknown>) {
  return (async () => {
    const out: string[] = [];
    for await (const ev of gen as AsyncGenerator<any>)
      if (ev.type === "tool_result") out.push(ev.result.content);
    return out;
  })();
}

test("registers the Agent tool and runs a child to completion when a definition exists", async () => {
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ subagent_type: "echo", prompt: "hi", resume: "agent-echo-fixed1" }] } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: process.cwd(), agentsDir: agentsDir("echo") });
  const results = await collectResults(agent.run("start"));
  expect(results.join("")).toContain("child-done");
  expect(results.join("")).toContain("agentId: agent-echo-fixed1");
  expect(results.join("")).not.toMatch(/unknown tool/);
});

test("agents:false leaves the Agent tool unregistered", async () => {
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ subagent_type: "echo", prompt: "hi" }] } }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: process.cwd(), agentsDir: agentsDir("echo"), agents: false });
  const results = await collectResults(agent.run("start"));
  expect(results.join("")).toMatch(/unknown tool 'Agent'/);
});

test("a subagent run persists a durable transcript under sessionsDir", async () => {
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ subagent_type: "echo", prompt: "hi", resume: "agent-echo-persist1" }] } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: process.cwd(), agentsDir: agentsDir("echo") });
  await collectResults(agent.run("start"));
  const paths = resolveProjectPaths({ workdir: process.cwd() });
  const files = readdirSync(paths.sessionsDir);
  expect(files).toContain("agent-echo-persist1.jsonl");
});

test("a subagent shares the project task list with its parent", async () => {
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ subagent_type: "tasker", prompt: "make a task", resume: "agent-tasker-share1" }] } }] } },
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "TaskCreate", input: { subject: "from child", description: "d" } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: process.cwd(), agentsDir: agentsDir("tasker") });
  await collectResults(agent.run("start"));
  const paths = resolveProjectPaths({ workdir: process.cwd() });
  const store = fileTaskStore({ dir: paths.tasksDir, listId: "default" });
  expect(store.list().some((t) => t.subject === "from child")).toBe(true);
});
```

- [ ] **Step 6: Run to verify the wiring tests fail**

Run: `pnpm --filter @lite-agent/sdk test -- subagents`
Expected: FAIL — `Agent` tool unregistered (`unknown tool 'Agent'`), so the first/third/fourth tests fail.

- [ ] **Step 7: Implement the `createLiteAgent` wiring**

In `packages/sdk/src/createLiteAgent.ts`:

(a) Add imports near the other tool imports:

```ts
import { AgentLoader } from "./agents/loader";
import { agentTool } from "./tools/agent";
import type { Spawn } from "./tools/agent";
```

(b) Add options to `CreateLiteAgentConfig` (after `taskListId`):

```ts
  /** File-defined subagents + the `Agent` dispatch tool. Default true. */
  agents?: boolean;
  /** Extra agents dir, appended last so it overrides global + project. */
  agentsDir?: string;
  /** Permission policy applied to subagent runs. Default: none (lenient — sandbox still applies). */
  subagentPermission?: PermissionPolicy;
```

(`PermissionPolicy` is already imported in this file.)

(c) Insert the subagents block AFTER the Tasks API block (after the `if (taskStore) tools.push(...taskTools(taskStore));` line) and BEFORE `if (cfg.tools) tools.push(...cfg.tools);`. It both registers the tool and computes the descriptions used by the system prompt:

```ts
  // Subagents: file-defined agents + the parallel `Agent` dispatch tool.
  let subagents = "(no subagents available)";
  if (cfg.agents !== false) {
    const agentLoader = new AgentLoader([
      paths.globalAgentsDir,
      paths.projectAgentsDir,
      ...(cfg.agentsDir ? [cfg.agentsDir] : []),
    ]);
    if (agentLoader.names().length > 0) {
      subagents = agentLoader.getDescriptions();
      const spawn: Spawn = async (def, prompt, { signal, sessionId }) => {
        const child = createLiteAgent({
          ...cfg,
          system:
            `You are the "${def.name}" subagent operating in ${cfg.workdir}. ` +
            `Return your final answer as your last message.\n\n${def.body}`,
          modelName: def.model ?? cfg.modelName,
          allowedTools: def.tools ?? cfg.allowedTools,
          agents: false, // no recursion: the child gets no Agent tool
          cleanup: false, // the parent already swept at startup
          permission: cfg.subagentPermission, // undefined → lenient (no gate)
          onApproval: undefined, // don't share the interactive handler (avoids interleaving)
        });
        const r = await child.send([{ role: "user", content: prompt }], { signal, sessionId });
        return r.text;
      };
      tools.push(agentTool({ loader: agentLoader, spawn }));
    }
  }
```

(d) Pass `subagents` to the system prompt. Change the `buildSystemPrompt` call:

```ts
  const system =
    cfg.system ??
    buildSystemPrompt({ workdir: cfg.workdir, modelName: cfg.modelName, skills, subagents });
```

- [ ] **Step 8: Implement the `query` threading**

In `packages/sdk/src/query.ts`:

Add to `QueryOptions` (after `taskListId`):

```ts
  agents?: boolean;
  agentsDir?: string;
  subagentPermission?: PermissionPolicy;
```

(`PermissionPolicy` is already imported in this file.)

And pass them through in the `createLiteAgent({ ... })` call (after `taskListId: opts.taskListId,`):

```ts
    agents: opts.agents,
    agentsDir: opts.agentsDir,
    subagentPermission: opts.subagentPermission,
```

- [ ] **Step 9: Implement the exports**

In `packages/sdk/src/tools/index.ts`, add after the `taskTools` export:

```ts
export { agentTool } from "./agent";
```

In `packages/sdk/src/index.ts`, add after the `taskReminder`/tasks type exports:

```ts
export { AgentLoader } from "./agents/loader";
export type { AgentDefinition } from "./agents/types";
export { agentTool } from "./tools/agent";
export type { Spawn, SpawnOptions } from "./tools/agent";
```

- [ ] **Step 10: Run the wiring + full sdk suite**

Run: `pnpm --filter @lite-agent/sdk test -- subagents`
Expected: PASS (4 tests)

Run: `pnpm --filter @lite-agent/sdk test`
Expected: PASS (all sdk tests green)

- [ ] **Step 11: Typecheck**

Run: `pnpm --filter @lite-agent/sdk typecheck`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add packages/sdk/src/system.ts packages/sdk/src/createLiteAgent.ts packages/sdk/src/query.ts packages/sdk/src/tools/index.ts packages/sdk/src/index.ts packages/sdk/test/system.test.ts packages/sdk/test/subagents.test.ts
git commit -m "feat(sdk): wire file-defined subagents into createLiteAgent/query + Subagents prompt"
```

---

### Task 5: Changeset + docs

**Files:**
- Create: `.changeset/subagents.md`
- Modify: `CLAUDE.md` (project root)

- [ ] **Step 1: Add the changeset**

Create `.changeset/subagents.md` (verify the four package names against an existing file in `.changeset/` first; they are the fixed set):

```markdown
---
"lite-agent": minor
"@lite-agent/core": minor
"@lite-agent/provider": minor
"@lite-agent/sandbox-anthropic": minor
---

feat(sdk): file-defined subagents loaded from `agents/*.md` (global `~/.lite-agent/agents` + project `.lite-agent/agents`), dispatched via a parallel-capable `Agent` tool. Each subagent runs in an isolated, persisted, resumable session and may share the project task list. Default-on; disable with `agents: false`.
```

- [ ] **Step 2: Verify the changeset package names**

Run: `ls .changeset && cat .changeset/*.md | head -20`
Expected: the four names above match the existing convention (e.g. the `task-tools` changeset). Fix any mismatch.

- [ ] **Step 3: Update `CLAUDE.md`**

In `packages/sdk/.../CLAUDE.md`'s "SDK batteries" paragraph (the project-root `CLAUDE.md` section describing `createLiteAgent`), append one sentence after the Tasks/skills description:

> It also loads file-defined **subagents** from `~/.lite-agent/agents` + `<workdir>/.lite-agent/agents`, registering a parallel-capable `Agent` dispatch tool (default on; `agents:false` disables) whose children run isolated, persisted, resumable sessions.

(Find the exact paragraph with `grep -n "createLiteAgent" CLAUDE.md` and edit in place; keep the surrounding wording.)

- [ ] **Step 4: Commit**

```bash
git add .changeset/subagents.md CLAUDE.md
git commit -m "docs(sdk): changeset + CLAUDE.md note for subagents"
```

---

## Self-Review

**Spec coverage:**
- Directory layout (global + project agents dirs) → Task 1. ✓
- `AgentDefinition` + `AgentLoader` (precedence, frontmatter, tools normalize, name fallback) → Task 2. ✓
- `Agent` tool (batch, bounded parallel, unknown-type, isolation, resume, per-task error) → Task 3. ✓
- Wiring (loader gated on `agents!==false`, spawn re-invokes createLiteAgent, lenient permission, no shared onApproval, `agents`/`agentsDir`/`subagentPermission` options, query threading) → Task 4 Step 7–8. ✓
- Persistence (durable transcript under sessionsDir) + resume (sessionId reuse) → Task 3 (id alloc) + Task 4 (default jsonlStore; persistence test). ✓
- Shared task list → Task 4 Step 5 (shared-task-list test). ✓
- System prompt `## Subagents` section → Task 4 Steps 1–3. ✓
- Changeset + docs → Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertions.

**Type consistency:** `AgentDefinition` fields (`name/description/tools?/model?/body/path`) are identical across Task 2 (definition), Task 3 (`Spawn` consumes `def.name`), and Task 4 (`def.body/model/tools`). `Spawn = (def, prompt, {signal, sessionId}) => Promise<string>` is identical in Task 3 (export) and Task 4 (implementation). `buildSystemPrompt` gains exactly one optional field `subagents?: string`, used consistently in Task 4 Steps 1/3/7. The `Agent` result format `## subagent[i] <type> (agentId: <id>)\n<out>` is asserted in Task 3 and Task 4 with matching shapes.

**Note on shared fakeProvider (Task 4):** parent and child kernels share one `fakeProvider` instance whose turn counter is global, so turns fire in the documented order (parent→child→parent). The tests are crafted around that sequence; do not give the child a turn that emits an `Agent` call (the child has no `Agent` tool).
