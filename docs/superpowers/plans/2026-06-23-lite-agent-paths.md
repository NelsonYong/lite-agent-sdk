# `.lite-agent` Paths, Default Persistence & Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `lite-agent-sdk` a Claude Code–style home (`~/.lite-agent`) with per-project runtime artifacts, two-source skill loading (global + project), and on-by-default session persistence / tool-result spill / deterministic compaction / age-based cleanup — all opt-out.

**Architecture:** All new code lives in the **sdk** package (filesystem = batteries); **core is unchanged** and reused via its existing `Store` / `SpillStore` / `Compactor` strategies. A pure `paths.ts` computes the directory layout from `workdir` + home; `createLiteAgent` resolves those paths once and wires the default stores/compactor/cleanup, each individually overridable. Test isolation is achieved with a vitest `setupFiles` that points `LITE_AGENT_HOME` at a fresh tmpdir.

**Tech Stack:** TypeScript 6 (ESM, strict, `verbatimModuleSyntax`), vitest, Node `fs`/`os`/`path`/`crypto`, zod (existing tool defs). Spec: `docs/superpowers/specs/2026-06-23-lite-agent-paths-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `packages/sdk/src/paths.ts` | Pure path computation: `liteAgentHome()`, `projectHash()`, `resolveProjectPaths()` → `ProjectPaths`. No fs side effects. |
| **Create** `packages/sdk/src/cleanup.ts` | `sweepStale()` — age-based delete of stale `spill`/`sessions` files across all projects. |
| **Modify** `packages/sdk/src/skills/loader.ts` | `SkillLoader` accepts `string \| string[]` (later dir overrides earlier); add `names()`. |
| **Modify** `packages/sdk/src/createLiteAgent.ts` | Resolve paths once; default-on `sessions`/`spill`/`compactor`/`cleanup`; merge skill dirs; new `home` option. |
| **Modify** `packages/sdk/src/query.ts` | Pass new options (`home`/`sessions`/`spill`/`cleanup`, widen `compactor`) through to `createLiteAgent`. |
| **Modify** `packages/sdk/src/index.ts` | Export `resolveProjectPaths`/`liteAgentHome`/`projectHash`/`ProjectPaths`/`sweepStale`. |
| **Create** `packages/sdk/vitest.config.ts` | `include: test/**/*.test.ts` + `setupFiles`. |
| **Create** `packages/sdk/test/setup.ts` | Set `process.env.LITE_AGENT_HOME` to a fresh `mkdtemp` dir (disk isolation). |
| **Create** `packages/sdk/test/{paths,cleanup,defaults}.test.ts` | New unit/integration tests. |
| **Modify** `packages/sdk/test/skills.test.ts` | Add multi-dir override + `names()` tests. |
| **Modify** `packages/sdk/test/query.test.ts` | Add option-passthrough test. |
| **Create** `.changeset/lite-agent-paths-defaults.md` | Minor bump for `@lite-agent/sdk`. |

**Build-before-test note:** these are all sdk-package changes; sdk tests import `../src/*` directly (esbuild strips types, no rebuild needed for own-package tests). Run `pnpm --filter @lite-agent/sdk test` per task. The final task runs the full `pnpm -r build && pnpm -r test && pnpm -r typecheck`.

---

## Task 1: `paths.ts` — pure path computation

**Files:**
- Create: `packages/sdk/src/paths.ts`
- Create: `packages/sdk/test/paths.test.ts`
- Modify: `packages/sdk/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/paths.test.ts`:

```ts
import { expect, test } from "vitest";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { liteAgentHome, projectHash, resolveProjectPaths } from "../src/paths";

test("liteAgentHome honors LITE_AGENT_HOME, else ~/.lite-agent", () => {
  const original = process.env.LITE_AGENT_HOME;
  try {
    process.env.LITE_AGENT_HOME = "/tmp/custom-home";
    expect(liteAgentHome()).toBe("/tmp/custom-home");
    delete process.env.LITE_AGENT_HOME;
    expect(liteAgentHome()).toBe(join(homedir(), ".lite-agent"));
  } finally {
    if (original === undefined) delete process.env.LITE_AGENT_HOME;
    else process.env.LITE_AGENT_HOME = original;
  }
});

test("projectHash is deterministic, absolute-resolved, and path-specific", () => {
  expect(projectHash("/a/b")).toBe(projectHash("/a/b"));
  expect(projectHash(".")).toBe(projectHash(resolve(".")));
  expect(projectHash("/a/b")).not.toBe(projectHash("/a/c"));
  expect(projectHash("/a/b")).toMatch(/^[0-9a-f]{16}$/);
});

test("resolveProjectPaths derives the project + global subpaths", () => {
  const p = resolveProjectPaths({ workdir: "/proj", home: "/home" });
  const projectDir = join("/home", "projects", projectHash("/proj"));
  expect(p).toEqual({
    home: "/home",
    hash: projectHash("/proj"),
    spillDir: join(projectDir, "spill"),
    sessionsDir: join(projectDir, "sessions"),
    globalSkillsDir: join("/home", "skills"),
    projectSkillsDir: join("/proj", ".lite-agent", "skills"),
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- paths`
Expected: FAIL — `Cannot find module '../src/paths'` / `liteAgentHome is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/sdk/src/paths.ts`:

```ts
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

/** Global home: `$LITE_AGENT_HOME` if set, else `~/.lite-agent`. */
export function liteAgentHome(): string {
  return process.env.LITE_AGENT_HOME || join(homedir(), ".lite-agent");
}

/** Stable per absolute project path: first 16 hex of sha1(resolve(workdir)). */
export function projectHash(workdir: string): string {
  return createHash("sha1").update(resolve(workdir)).digest("hex").slice(0, 16);
}

export interface ProjectPaths {
  home: string;
  hash: string;
  spillDir: string;
  sessionsDir: string;
  globalSkillsDir: string;
  projectSkillsDir: string;
}

/** Pure: derive every path from `workdir` (+ optional home). No fs side effects. */
export function resolveProjectPaths(opts: { workdir: string; home?: string }): ProjectPaths {
  const home = opts.home ?? liteAgentHome();
  const hash = projectHash(opts.workdir);
  const projectDir = join(home, "projects", hash);
  return {
    home,
    hash,
    spillDir: join(projectDir, "spill"),
    sessionsDir: join(projectDir, "sessions"),
    globalSkillsDir: join(home, "skills"),
    projectSkillsDir: join(resolve(opts.workdir), ".lite-agent", "skills"),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @lite-agent/sdk test -- paths`
Expected: PASS (3 tests).

- [ ] **Step 5: Export the new symbols**

In `packages/sdk/src/index.ts`, add after the `jsonlStore` exports (around line 21):

```ts
export { liteAgentHome, projectHash, resolveProjectPaths } from "./paths";
export type { ProjectPaths } from "./paths";
```

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/paths.ts packages/sdk/test/paths.test.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): add paths.ts (.lite-agent home + project path resolution)"
```

---

## Task 2: `SkillLoader` — multi-dir merge + `names()`

**Files:**
- Modify: `packages/sdk/src/skills/loader.ts`
- Modify: `packages/sdk/test/skills.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/test/skills.test.ts`:

```ts
test("a later dir overrides an earlier dir on name collision", () => {
  const a = mkdtempSync(join(tmpdir(), "sk-a-"));
  const b = mkdtempSync(join(tmpdir(), "sk-b-"));
  mkdirSync(join(a, "demo"));
  mkdirSync(join(b, "demo"));
  writeFileSync(join(a, "demo", "SKILL.md"), "---\nname: demo\ndescription: from A\n---\nBODY A");
  writeFileSync(join(b, "demo", "SKILL.md"), "---\nname: demo\ndescription: from B\n---\nBODY B");

  const loader = new SkillLoader([a, b]);
  expect(loader.getContent("demo")).toContain("BODY B");
  expect(loader.getContent("demo")).not.toContain("BODY A");
});

test("names() lists loaded skills; a missing dir in the list is skipped", () => {
  const a = mkdtempSync(join(tmpdir(), "sk-a-"));
  mkdirSync(join(a, "demo"));
  writeFileSync(join(a, "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nB");

  const loader = new SkillLoader([join(tmpdir(), "missing-xyz"), a]);
  expect(loader.names()).toEqual(["demo"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lite-agent/sdk test -- skills`
Expected: FAIL — `new SkillLoader([a, b])` passes an array where a `string` is expected (the loader stringifies it / `existsSync` on the array fails), and `loader.names` is not a function.

- [ ] **Step 3: Write the minimal implementation**

In `packages/sdk/src/skills/loader.ts`, replace the field + constructor + `loadAll` (lines 8–30) with:

```ts
export class SkillLoader {
  readonly dirs: string[];
  private skills: Record<string, Skill> = {};

  constructor(dirs: string | string[]) {
    this.dirs = Array.isArray(dirs) ? dirs : [dirs];
    this.loadAll();
  }

  private loadAll(): void {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === "SKILL.md") {
          const { meta, body } = this.parse(readFileSync(p, "utf8"));
          const name = meta.name ?? dirname(p).split("/").pop() ?? p;
          this.skills[name] = { meta, body, path: p };
        }
      }
    };
    // Walk in order; later dirs overwrite earlier ones on name collision.
    for (const dir of this.dirs) {
      if (existsSync(dir)) walk(dir);
    }
  }
```

Then add a `names()` accessor next to `getDescriptions()` (after the `getDescriptions()` method, before `getContent`):

```ts
  names(): string[] {
    return Object.keys(this.skills);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lite-agent/sdk test -- skills`
Expected: PASS — including the existing two skills tests (string constructor still works via the `Array.isArray` normalization).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/skills/loader.ts packages/sdk/test/skills.test.ts
git commit -m "feat(sdk): SkillLoader accepts ordered dir list (later overrides) + names()"
```

---

## Task 3: `cleanup.ts` — `sweepStale`

**Files:**
- Create: `packages/sdk/src/cleanup.ts`
- Create: `packages/sdk/test/cleanup.test.ts`
- Modify: `packages/sdk/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/cleanup.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStale } from "../src/cleanup";

const DAY = 86_400_000;

// Build <home>/projects/<proj>/<sub>/<file>, optionally aged `ageDays` old.
function seed(home: string, proj: string, sub: string, file: string, ageDays: number): string {
  const dir = join(home, "projects", proj, sub);
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, file);
  writeFileSync(fp, "x");
  const when = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(fp, when, when);
  return fp;
}

test("deletes files older than maxAgeDays, keeps fresh ones, across projects", () => {
  const home = mkdtempSync(join(tmpdir(), "sweep-"));
  const oldA = seed(home, "projA", "spill", "old.txt", 40);
  const freshA = seed(home, "projA", "sessions", "fresh.jsonl", 1);
  const oldB = seed(home, "projB", "sessions", "old.jsonl", 31);

  sweepStale({ home, maxAgeDays: 30 });

  expect(existsSync(oldA)).toBe(false);
  expect(existsSync(oldB)).toBe(false);
  expect(existsSync(freshA)).toBe(true);
});

test("tolerates a missing home without throwing", () => {
  expect(() => sweepStale({ home: join(tmpdir(), "no-such-home-xyz") })).not.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- cleanup`
Expected: FAIL — `Cannot find module '../src/cleanup'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/sdk/src/cleanup.ts`:

```ts
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { liteAgentHome } from "./paths";

const DAY_MS = 86_400_000;

/**
 * Delete stale runtime files under `<home>/projects/*​/{spill,sessions}` whose
 * mtime is older than `maxAgeDays` (default 30). Global sweep, synchronous, and
 * fully guarded — a failure here must never block agent startup.
 */
export function sweepStale(opts: { home?: string; maxAgeDays?: number } = {}): void {
  const home = opts.home ?? liteAgentHome();
  const cutoff = Date.now() - (opts.maxAgeDays ?? 30) * DAY_MS;
  try {
    const projectsDir = join(home, "projects");
    if (!existsSync(projectsDir)) return;
    for (const project of readdirSync(projectsDir)) {
      for (const sub of ["spill", "sessions"]) {
        const dir = join(projectsDir, project, sub);
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          const fp = join(dir, name);
          try {
            if (statSync(fp).mtimeMs < cutoff) rmSync(fp);
          } catch {
            /* skip a file that vanished or can't be stat'd */
          }
        }
      }
    }
  } catch {
    /* never block startup on cleanup */
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @lite-agent/sdk test -- cleanup`
Expected: PASS (2 tests).

- [ ] **Step 5: Export `sweepStale`**

In `packages/sdk/src/index.ts`, add below the paths exports from Task 1:

```ts
export { sweepStale } from "./cleanup";
```

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/cleanup.ts packages/sdk/test/cleanup.test.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): sweepStale — age-based cleanup of spill/sessions"
```

---

## Task 4: Test isolation — vitest `setupFiles` → tmp `LITE_AGENT_HOME`

This MUST land before Task 5: once `createLiteAgent` is default-on it writes sessions + sweeps the home, so the suite needs an isolated home.

**Files:**
- Create: `packages/sdk/test/isolation.test.ts`
- Create: `packages/sdk/vitest.config.ts`
- Create: `packages/sdk/test/setup.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/isolation.test.ts`:

```ts
import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

test("the suite runs with an isolated LITE_AGENT_HOME under tmpdir", () => {
  const home = process.env.LITE_AGENT_HOME;
  expect(home).toBeTruthy();
  expect(home!.startsWith(tmpdir())).toBe(true);
  expect(existsSync(home!)).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- isolation`
Expected: FAIL — `expect(home).toBeTruthy()` fails (env var unset; no setup yet).

- [ ] **Step 3: Write the setup file + config**

Create `packages/sdk/test/setup.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point every test file at a throwaway home so default-on persistence/cleanup
// never touches the developer's real ~/.lite-agent.
process.env.LITE_AGENT_HOME = mkdtempSync(join(tmpdir(), "lite-home-"));
```

Create `packages/sdk/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @lite-agent/sdk test -- isolation`
Expected: PASS.

- [ ] **Step 5: Run the whole sdk suite (no regressions)**

Run: `pnpm --filter @lite-agent/sdk test`
Expected: PASS — all existing tests still green (setup only sets an env var none of them read yet).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/vitest.config.ts packages/sdk/test/setup.ts packages/sdk/test/isolation.test.ts
git commit -m "test(sdk): isolate suite with a tmp LITE_AGENT_HOME via setupFiles"
```

---

## Task 5: `createLiteAgent` — default-on persistence wiring

Wire paths + default `sessions`/`spill`/`compactor`/`cleanup` + global/project skill merge + new `home` option. Because these behaviors interlock in one small function, write the full default-on test set first (watch them fail), then replace the function once.

**Files:**
- Create: `packages/sdk/test/defaults.test.ts`
- Modify: `packages/sdk/src/createLiteAgent.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/test/defaults.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock } from "@lite-agent/core";
import type { Message } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { resolveProjectPaths } from "../src/paths";

const home = () => process.env.LITE_AGENT_HOME!;
const freshWorkdir = () => mkdtempSync(join(tmpdir(), "wd-"));
const sayOk = () => fakeProvider([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]);

// A model that calls one tool, then finishes — used to probe tool registration.
const callTool = (name: string, input: Record<string, unknown>) =>
  fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name, input }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);

async function toolResults(agent: ReturnType<typeof createLiteAgent>): Promise<string> {
  const out: string[] = [];
  for await (const ev of agent.run("hi")) if (ev.type === "tool_result") out.push(ev.result.content);
  return out.join("");
}

test("sessions on by default → transcript written under sessionsDir", async () => {
  const workdir = freshWorkdir();
  const agent = createLiteAgent({ model: sayOk(), workdir });
  await agent.send("hi", { sessionId: "sess1" });
  const { sessionsDir } = resolveProjectPaths({ workdir, home: home() });
  expect(existsSync(join(sessionsDir, "sess1.jsonl"))).toBe(true);
});

test("sessions:false → nothing written", async () => {
  const workdir = freshWorkdir();
  const agent = createLiteAgent({ model: sayOk(), workdir, sessions: false });
  await agent.send("hi", { sessionId: "sess2" });
  const { sessionsDir } = resolveProjectPaths({ workdir, home: home() });
  expect(existsSync(join(sessionsDir, "sess2.jsonl"))).toBe(false);
});

test("home override redirects where sessions are written", async () => {
  const workdir = freshWorkdir();
  const customHome = mkdtempSync(join(tmpdir(), "home-"));
  const agent = createLiteAgent({ model: sayOk(), workdir, home: customHome });
  await agent.send("hi", { sessionId: "sess3" });
  const { sessionsDir } = resolveProjectPaths({ workdir, home: customHome });
  expect(existsSync(join(sessionsDir, "sess3.jsonl"))).toBe(true);
});

test("spill on by default → read_spilled is registered", async () => {
  const agent = createLiteAgent({ model: callTool("read_spilled", { ref: "nope" }), workdir: freshWorkdir() });
  expect(await toolResults(agent)).toContain("No spilled content for ref 'nope'");
});

test("spill:false → read_spilled is not registered", async () => {
  const agent = createLiteAgent({ model: callTool("read_spilled", { ref: "nope" }), workdir: freshWorkdir(), spill: false });
  expect(await toolResults(agent)).toMatch(/unknown tool/);
});

test("compactor:false → no compaction even on a history that would trigger", async () => {
  // 6 turns × 3 msgs = 18 messages with sizeable tool_results — defaultCompactor
  // would micro-shrink these; compactor:false must skip compaction entirely.
  const turn = (i: number): Message[] => [
    { role: "user", content: `q${i}` },
    { role: "assistant", content: [{ type: "tool_call", id: `c${i}`, name: "f", input: {} }] },
    { role: "user", content: [{ type: "tool_result", id: `c${i}`, content: `r${i}-`.repeat(50) }] },
  ];
  const history = [0, 1, 2, 3, 4, 5].flatMap(turn);
  const agent = createLiteAgent({ model: sayOk(), workdir: freshWorkdir(), compactor: false });
  const types: string[] = [];
  for await (const ev of agent.run(history)) types.push(ev.type);
  expect(types).not.toContain("compaction");
});

test("a project skill shadows a same-named global skill", async () => {
  const workdir = freshWorkdir();
  const { globalSkillsDir, projectSkillsDir } = resolveProjectPaths({ workdir, home: home() });
  mkdirSync(join(globalSkillsDir, "demo"), { recursive: true });
  mkdirSync(join(projectSkillsDir, "demo"), { recursive: true });
  writeFileSync(join(globalSkillsDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: g\n---\nGLOBAL BODY");
  writeFileSync(join(projectSkillsDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: p\n---\nPROJECT BODY");

  const agent = createLiteAgent({ model: callTool("load_skill", { name: "demo" }), workdir });
  const res = await toolResults(agent);
  expect(res).toContain("PROJECT BODY");
  expect(res).not.toContain("GLOBAL BODY");
});

test("cleanup default removes a stale file; cleanup:false keeps it", async () => {
  // Seed a stale sessions file under the isolated home for some unrelated project.
  const stale = (sub: string) => {
    const dir = join(home(), "projects", "deadbeefdeadbeef", sub);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, "old.jsonl");
    writeFileSync(fp, "x");
    const when = (Date.now() - 40 * 86_400_000) / 1000;
    utimesSync(fp, when, when);
    return fp;
  };

  const kept = stale("sessions");
  createLiteAgent({ model: sayOk(), workdir: freshWorkdir(), cleanup: false });
  expect(existsSync(kept)).toBe(true);

  const swept = stale("spill");
  createLiteAgent({ model: sayOk(), workdir: freshWorkdir() });
  expect(existsSync(swept)).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lite-agent/sdk test -- defaults`
Expected: FAIL — e.g. sessions test fails (no file: default store not wired), `read_spilled` test reports "unknown tool", `home` option is rejected by the type / ignored, etc.

- [ ] **Step 3: Replace `createLiteAgent.ts` with the default-on wiring**

Overwrite `packages/sdk/src/createLiteAgent.ts` with:

```ts
import {
  createAgent,
  nativeCodec,
  permission,
  compaction,
  reactiveCompaction,
  defaultCompactor,
} from "@lite-agent/core";
import type {
  Agent,
  ApprovalHandler,
  Compactor,
  InputHandler,
  Middleware,
  ModelProvider,
  PermissionPolicy,
  Sandbox,
  Store,
  Tool,
} from "@lite-agent/core";
import { defaultTools, askUserTool } from "./tools";
import { SkillLoader } from "./skills/loader";
import { loadSkillTool } from "./skills/loadSkillTool";
import { buildSystemPrompt } from "./system";
import { resolveProjectPaths } from "./paths";
import { jsonlStore } from "./store";
import { fileSpillStore, readSpilledTool } from "./spill";
import { sweepStale } from "./cleanup";

export interface CreateLiteAgentConfig {
  model: ModelProvider;
  modelName?: string;
  workdir: string;
  skillsDir?: string;
  tools?: Tool[];
  system?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxTokens?: number;
  use?: Middleware[];
  sandbox?: Sandbox;
  store?: Store;
  /** Override the global home (default `$LITE_AGENT_HOME` || `~/.lite-agent`). */
  home?: string;
  /** Persist transcripts under the project's sessions dir. Default true. Ignored when `store` is set. */
  sessions?: boolean;
  /** Spill oversized tool_results to disk + register `read_spilled`. Default true. */
  spill?: boolean | { budgetBytes?: number };
  /** Proactive compactor. Default deterministic `defaultCompactor`; `false` disables compaction. */
  compactor?: Compactor | false;
  /** Sweep stale spill/session files once at startup. Default true (30 days). */
  cleanup?: boolean | { maxAgeDays?: number };
  permission?: PermissionPolicy;
  onApproval?: ApprovalHandler;
  onAskUser?: InputHandler;
}

export function createLiteAgent(cfg: CreateLiteAgentConfig): Agent {
  const paths = resolveProjectPaths({ workdir: cfg.workdir, home: cfg.home });

  // Age-based cleanup runs once at construction (global sweep, fully guarded).
  if (cfg.cleanup !== false) {
    sweepStale({
      home: paths.home,
      maxAgeDays: typeof cfg.cleanup === "object" ? cfg.cleanup.maxAgeDays : undefined,
    });
  }

  let tools: Tool[] = [...defaultTools(cfg.workdir)];

  // Skills: global < project < explicit skillsDir (later overrides earlier).
  const loader = new SkillLoader([
    paths.globalSkillsDir,
    paths.projectSkillsDir,
    ...(cfg.skillsDir ? [cfg.skillsDir] : []),
  ]);
  let skills = "(no skills available)";
  if (loader.names().length > 0) {
    tools.push(loadSkillTool(loader));
    skills = loader.getDescriptions();
  }

  // L3 spill: content-addressed store + retrieval tool, on by default.
  const spillEnabled = cfg.spill !== false;
  const spillStore = spillEnabled ? fileSpillStore({ dir: paths.spillDir }) : undefined;
  if (spillStore) tools.push(readSpilledTool(spillStore));

  if (cfg.tools) tools.push(...cfg.tools);
  if (cfg.onAskUser) tools.push(askUserTool());
  if (cfg.allowedTools)
    tools = tools.filter((t) => cfg.allowedTools!.includes(t.name));
  if (cfg.disallowedTools)
    tools = tools.filter((t) => !cfg.disallowedTools!.includes(t.name));

  const system =
    cfg.system ??
    buildSystemPrompt({ workdir: cfg.workdir, modelName: cfg.modelName, skills });

  // Compaction: explicit compactor wins; `false` disables; default = deterministic
  // pipeline with the spill store auto-injected (no LLM call ever by default).
  const compactor =
    cfg.compactor === false
      ? undefined
      : cfg.compactor ??
        defaultCompactor({
          spillStore,
          budgetBytes: typeof cfg.spill === "object" ? cfg.spill.budgetBytes : undefined,
        });

  // Sessions: explicit store wins; else default jsonlStore unless sessions:false.
  const store =
    cfg.store ?? (cfg.sessions === false ? undefined : jsonlStore({ dir: paths.sessionsDir }));

  const use: Middleware[] = [
    // proactive compaction (beforeModel) + reactive overflow net (wrapModelCall)
    ...(compactor ? [compaction(compactor), reactiveCompaction()] : []),
    ...(cfg.permission ? [permission(cfg.permission, cfg.onApproval)] : []),
    ...(cfg.use ?? []),
  ];

  return createAgent({
    model: cfg.model,
    modelName: cfg.modelName,
    codec: nativeCodec(),
    tools,
    use,
    system,
    maxTurns: cfg.maxTurns,
    maxTokens: cfg.maxTokens,
    sandbox: cfg.sandbox,
    store,
    input: cfg.onAskUser,
  });
}
```

- [ ] **Step 4: Run the new tests, then the whole sdk suite**

Run: `pnpm --filter @lite-agent/sdk test -- defaults`
Expected: PASS (8 tests).

Run: `pnpm --filter @lite-agent/sdk test`
Expected: PASS — existing `createLiteAgent.test.ts` stays green: the explicit-`store` and explicit-`compactor` tests still take their provided values (`cfg.store ?? …`, `cfg.compactor ?? …`); short runs make the default compactor a no-op (no `compaction` event); the `allowedTools:["bash"]` test still filters `read_file` → "unknown tool".

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/createLiteAgent.ts packages/sdk/test/defaults.test.ts
git commit -m "feat(sdk): default-on sessions/spill/compaction/cleanup + global+project skills"
```

---

## Task 6: `query` — pass new options through

**Files:**
- Modify: `packages/sdk/src/query.ts`
- Modify: `packages/sdk/test/query.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/sdk/test/query.test.ts`:

```ts
import { existsSync as existsSync2 } from "node:fs";
import { mkdtempSync as mkdtempSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join2 } from "node:path";
import { resolveProjectPaths } from "../src/paths";

test("query forwards sessions:false (no transcript written)", async () => {
  const cwd = mkdtempSync2(join2(tmpdir2(), "q-wd-"));
  const gen = query({
    prompt: "hi",
    model: fakeProvider([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]),
    cwd,
    sessionId: "qs1",
    sessions: false,
  });
  // drive the generator to completion
  for await (const _ev of gen) void _ev;
  const { sessionsDir } = resolveProjectPaths({ workdir: cwd, home: process.env.LITE_AGENT_HOME! });
  expect(existsSync2(join2(sessionsDir, "qs1.jsonl"))).toBe(false);
});
```

> Note: reuse whatever `query`, `fakeProvider`, and `textBlock` imports the existing `query.test.ts` already has at the top of the file; only add the four `node:` / `paths` imports shown above if they are not already imported. If `query.test.ts` already imports `fakeProvider`/`textBlock`/`query`, do not duplicate them.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- query`
Expected: FAIL — `query` rejects the unknown `sessions` option (TS) / ignores it, so a transcript IS written → `existsSync` is `true`.

- [ ] **Step 3: Add the options to `QueryOptions` and thread them**

In `packages/sdk/src/query.ts`, add to the `QueryOptions` interface (alongside the existing `store?`/`compactor?` fields):

```ts
  home?: string;
  sessions?: boolean;
  spill?: boolean | { budgetBytes?: number };
  cleanup?: boolean | { maxAgeDays?: number };
```

Change the existing `compactor?: Compactor;` line to:

```ts
  compactor?: Compactor | false;
```

Then in the `createLiteAgent({ … })` call inside `query()`, add the passthrough (next to `store: opts.store,` / `compactor: opts.compactor,`):

```ts
    home: opts.home,
    sessions: opts.sessions,
    spill: opts.spill,
    cleanup: opts.cleanup,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @lite-agent/sdk test -- query`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/query.ts packages/sdk/test/query.test.ts
git commit -m "feat(sdk): query passes home/sessions/spill/cleanup through to createLiteAgent"
```

---

## Task 7: Changeset + full-repo verification + self-review

**Files:**
- Create: `.changeset/lite-agent-paths-defaults.md`

- [ ] **Step 1: Write the changeset**

Create `.changeset/lite-agent-paths-defaults.md`:

```markdown
---
"@lite-agent/sdk": minor
---

feat(sdk): `.lite-agent` home, default persistence, and age-based cleanup

`createLiteAgent`/`query` adopt a Claude Code–style home (`$LITE_AGENT_HOME` || `~/.lite-agent`) and turn persistence on by default (all opt-out):

- **Paths** (`resolveProjectPaths` / `liteAgentHome` / `projectHash`): per-project runtime artifacts under `~/.lite-agent/projects/<sha1(workdir)>/{spill,sessions}`; global skills under `~/.lite-agent/skills`; project skills under `<workdir>/.lite-agent/skills`.
- **Skills**: loaded from global < project < explicit `skillsDir` (later overrides earlier).
- **Defaults** (each overridable): `sessions` → `jsonlStore`, `spill` → `fileSpillStore` + `read_spilled`, `compactor` → deterministic `defaultCompactor` (no LLM), `cleanup` → `sweepStale` (30-day sweep). Opt out via `sessions:false` / `spill:false` / `compactor:false` / `cleanup:false`; an explicit `store`/`compactor` overrides the default.

No core changes — built entirely on the existing `Store` / `SpillStore` / `Compactor` strategies.
```

- [ ] **Step 2: Full-repo build + test + typecheck**

Run: `pnpm -r build && pnpm -r test && pnpm -r typecheck`
Expected: PASS — all packages build; sdk gains the new tests (paths 3, skills +2, cleanup 2, isolation 1, defaults 8, query +1); typecheck clean (note the widened `compactor?: Compactor | false` in both `createLiteAgent` and `query`).

- [ ] **Step 3: Self-review against the spec**

Re-read `docs/superpowers/specs/2026-06-23-lite-agent-paths-design.md` and confirm each requirement maps to a task:
- Directory layout / `<hash>` → Task 1 (`resolveProjectPaths`, `projectHash`).
- `paths.ts` API → Task 1.
- SkillLoader multi-dir, global<project<explicit → Task 2 + Task 5.
- Default persistence table (`sessions`/`spill`/`compactor`/`cleanup`/`home`) + precedence (explicit store/compactor win; `spill:false` drops store+tool; default compaction = deterministic only) → Task 5.
- `sweepStale` global age sweep, guarded, once at construction → Task 3 + Task 5.
- Testability (`LITE_AGENT_HOME` + setupFiles tmpdir) → Task 4.
- Behavior change documented in a changeset, minor bump → Task 7.

Fix any gap inline before committing.

- [ ] **Step 4: Commit**

```bash
git add .changeset/lite-agent-paths-defaults.md
git commit -m "chore: changeset for .lite-agent paths, default persistence, and cleanup"
```

---

## Out of scope (per spec)

- Project-root discovery by walking up to `.git`/`.lite-agent` (uses `workdir` directly).
- Global config file under `~/.lite-agent`.
- Size-cap / LRU cleanup (age-based only).
