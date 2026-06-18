# Phase 3 Sandbox Boundary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a pluggable `Sandbox` strategy that gives `bash` (and future process tools) an OS-level runtime boundary, defaulting to a no-op so the core stays lean and cross-platform; ship a `@lite-agent/sandbox-anthropic` adapter wrapping `@anthropic-ai/sandbox-runtime`.

**Architecture:** `Sandbox` is the 9th pluggable strategy. Core defines the interface + `noopSandbox()` and threads it through `ToolContext`. The `bash` tool wraps its command via `ctx.sandbox.wrap()` before `execSync`. The Anthropic adapter lives in its own package so the experimental dependency stays out of core/sdk. Pairs with the (separately designed) `PermissionPolicy` gate as Phase 3's boundary layer.

**Tech Stack:** TS6 ESM (moduleResolution Bundler, verbatimModuleSyntax, strict, noUncheckedIndexedAccess), pnpm workspace, tsup, vitest, zod 4. Adapter deps on `@anthropic-ai/sandbox-runtime` ^0.0.55 (no install scripts; runtime-only OS deps, mocked in tests).

**Reference spec:** `docs/superpowers/specs/2026-06-18-phase-3-sandbox-boundary-design.md`.

## Notes (read once)

- `ToolContext.sandbox` is implemented as **optional** (`sandbox?: Sandbox`) to avoid breaking existing `ToolContext` literals in tests; the kernel always injects it (createAgent defaults to `noopSandbox()`), so at runtime it is always present. The `bash` tool guards with `ctx.sandbox ? await ctx.sandbox.wrap(...) : command`.
- `noopSandbox` is exported from a new `packages/core/src/sandbox.ts` (values live outside `strategies.ts`, which holds interfaces only).
- Build config: the new adapter package mirrors the existing build setup, including a `tsconfig.build.json` with `ignoreDeprecations: "6.0"` referenced via `tsup --tsconfig tsconfig.build.json` (the dts worker injects a deprecated `baseUrl`).
- Commit after each task with the `Co-Authored-By` trailer. Branch: `agent-core-sdk`.

---

## Task 1: Core — `Sandbox` strategy + `noopSandbox` + threading

**Files:**
- Modify: `packages/core/src/strategies.ts` (add `SandboxWrapOptions`, `Sandbox`; add `sandbox?` to `ToolContext`)
- Create: `packages/core/src/sandbox.ts` (`noopSandbox`)
- Modify: `packages/core/src/kernel.ts` (`KernelConfig.sandbox`; pass into tool `ToolContext`)
- Modify: `packages/core/src/createAgent.ts` (`CreateAgentConfig.sandbox?`; default `noopSandbox()`)
- Modify: `packages/core/src/index.ts` (export `noopSandbox`, types `Sandbox`, `SandboxWrapOptions`)
- Test: `packages/core/test/sandbox.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/core/test/sandbox.test.ts`

```ts
import { expect, test } from "vitest";
import { z } from "zod";
import { createAgent } from "../src/createAgent";
import { nativeCodec } from "../src/codecs/native";
import { fakeProvider } from "../src/testing/fakeProvider";
import { defineTool } from "../src/tools/define";
import { noopSandbox } from "../src/sandbox";
import { textBlock } from "../src/types";

function probeAgent(sandbox?: { id: string; wrap: (c: string) => string }, seen: string[] = []) {
  const probe = defineTool({
    name: "probe",
    description: "report the sandbox id from context",
    schema: z.object({}),
    execute: (_i, ctx) => { seen.push(ctx.sandbox?.id ?? "absent"); return "ok"; },
  });
  return createAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "probe", input: {} }] } },
      { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
    ]),
    codec: nativeCodec(),
    tools: [probe],
    ...(sandbox ? { sandbox } : {}),
  });
}

test("noopSandbox returns the command unchanged", async () => {
  expect(await noopSandbox().wrap("echo hi", { cwd: "/tmp" })).toBe("echo hi");
  expect(noopSandbox().id).toBe("noop");
});

test("kernel threads the configured sandbox into ToolContext", async () => {
  const seen: string[] = [];
  await probeAgent({ id: "test-sb", wrap: (c) => c }, seen).send("go");
  expect(seen).toEqual(["test-sb"]);
});

test("ToolContext.sandbox defaults to noopSandbox when none configured", async () => {
  const seen: string[] = [];
  await probeAgent(undefined, seen).send("go");
  expect(seen).toEqual(["noop"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core test sandbox`
Expected: FAIL — `noopSandbox` not found / `ctx.sandbox` absent.

- [ ] **Step 3: Add interfaces to `packages/core/src/strategies.ts`**

Add near the other strategy interfaces:

```ts
export interface SandboxWrapOptions {
  readonly cwd: string;
}

// 9th strategy — wraps a shell command so it runs inside an OS-level boundary.
export interface Sandbox {
  readonly id: string;
  wrap(command: string, opts: SandboxWrapOptions): Promise<string> | string;
  dispose?(): Promise<void> | void;
}
```

And add `sandbox` to the existing `ToolContext` interface (keep the other fields unchanged):

```ts
export interface ToolContext {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  emit(ev: AgentEvent): void;
  readonly approval?: ApprovalHandler;
  readonly input?: InputHandler;
  readonly sandbox?: Sandbox;
}
```

- [ ] **Step 4: Create `packages/core/src/sandbox.ts`**

```ts
import type { Sandbox } from "./strategies";

// Default boundary: none. Returns the command unchanged so behavior matches a
// world without a sandbox — keeps the core lean and cross-platform.
export function noopSandbox(): Sandbox {
  return { id: "noop", wrap: (command) => command };
}
```

- [ ] **Step 5: Thread through `packages/core/src/kernel.ts`**

Add `sandbox` to `KernelConfig`:

```ts
import type { ModelProvider, ToolCallCodec, Tool, Sandbox } from "./strategies";
```
```ts
export interface KernelConfig {
  provider: ModelProvider;
  codec: ToolCallCodec;
  tools: Tool[];
  middleware: Middleware[];
  model: string;
  system?: string;
  maxTurns: number;
  maxTokens?: number;
  sandbox: Sandbox;
}
```

In the tool dispatch, pass `sandbox` into the `ToolContext` handed to `execute` (the only change to that call):

```ts
const out = await tool.execute(parsed, { sessionId, signal, emit, sandbox: cfg.sandbox });
```

- [ ] **Step 6: Default it in `packages/core/src/createAgent.ts`**

Add to imports and config:

```ts
import type { ModelProvider, Tool, ToolCallCodec, Sandbox } from "./strategies";
import { noopSandbox } from "./sandbox";
```
```ts
export interface CreateAgentConfig {
  model: ModelProvider;
  modelName?: string;
  codec: ToolCallCodec;
  tools?: Tool[];
  use?: Middleware[];
  system?: string;
  maxTurns?: number;
  maxTokens?: number;
  sandbox?: Sandbox;
}
```

In the `kernelCfg` object literal add:

```ts
    sandbox: cfg.sandbox ?? noopSandbox(),
```

- [ ] **Step 7: Export from `packages/core/src/index.ts`**

Add:

```ts
export { noopSandbox } from "./sandbox";
```
and add `Sandbox, SandboxWrapOptions` to the existing `export type { ... } from "./strategies";` list.

- [ ] **Step 8: Run tests + typecheck**

Run: `pnpm --filter @lite-agent/core test`
Expected: PASS (all prior core tests + 3 new sandbox tests).
Run: `pnpm --filter @lite-agent/core typecheck`
Expected: clean.

- [ ] **Step 9: Rebuild core (downstream depends on its dist) + commit**

Run: `pnpm --filter @lite-agent/core build`
Expected: emits dist (so sdk/adapter resolve the new exports).

```bash
git add packages/core
git commit -m "feat(core): Sandbox strategy + noopSandbox, threaded into ToolContext"
```

---

## Task 2: SDK — `bash` wraps via sandbox; `createLiteAgent`/`query` config

**Files:**
- Modify: `packages/sdk/src/tools/bash.ts` (wrap command via `ctx.sandbox` before `execSync`)
- Modify: `packages/sdk/src/createLiteAgent.ts` (`sandbox?` config → `createAgent`)
- Modify: `packages/sdk/src/query.ts` (`sandbox?` option → `createLiteAgent`)
- Test: `packages/sdk/test/tools.test.ts` (add a direct bash-wrap unit test)
- Test: `packages/sdk/test/createLiteAgent.test.ts` (add an end-to-end sandbox-wrap test)

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/test/tools.test.ts`:

```ts
import { noopSandbox } from "@lite-agent/core";

test("bash wraps the command via ctx.sandbox before executing", async () => {
  const sandboxCtx = {
    sessionId: "s",
    signal: new AbortController().signal,
    emit: () => {},
    sandbox: { id: "fake", wrap: (c: string) => `echo [${c}]` },
  };
  const out = await bashTool(process.cwd()).execute({ command: "hi" }, sandboxCtx);
  expect(out).toBe("[hi]");
});

test("bash runs the command unchanged under noopSandbox", async () => {
  const noopCtx = { sessionId: "s", signal: new AbortController().signal, emit: () => {}, sandbox: noopSandbox() };
  expect(await bashTool(process.cwd()).execute({ command: "echo plain" }, noopCtx)).toBe("plain");
});
```

Append to `packages/sdk/test/createLiteAgent.test.ts`:

```ts
test("a configured sandbox wraps bash commands end-to-end", async () => {
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "bash", input: { command: "echo original" } }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({
    model: fp,
    workdir: process.cwd(),
    sandbox: { id: "fake", wrap: () => "echo wrapped-by-sandbox" },
  });
  const results: string[] = [];
  for await (const ev of agent.run("hi")) if (ev.type === "tool_result") results.push(ev.result.content);
  expect(results.join("")).toContain("wrapped-by-sandbox");
  expect(results.join("")).not.toContain("original");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lite-agent/sdk test tools createLiteAgent`
Expected: FAIL — `createLiteAgent` rejects `sandbox` / bash ignores `ctx.sandbox`.

- [ ] **Step 3: Update `packages/sdk/src/tools/bash.ts`**

Make `execute` async and wrap the command via the context sandbox before running. The dangerous-substring check stays on the ORIGINAL command:

```ts
    execute: async ({ command }, ctx) => {
      if (DANGEROUS.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
      const toRun = ctx.sandbox ? await ctx.sandbox.wrap(command, { cwd: workdir }) : command;
      try {
        const out = execSync(toRun, { cwd: workdir, encoding: "utf8", timeout: 120000, maxBuffer: 50_000_000 });
        return out.trim() || "(no output)";
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(0, 50_000) || `Error: ${err.message}`;
      }
    },
```

(The `import type { Tool }` line stays; no new import needed — `ctx` is already typed `ToolContext` by `defineTool`.)

- [ ] **Step 4: Update `packages/sdk/src/createLiteAgent.ts`**

Add `Sandbox` to the type import and a `sandbox?` field, and pass it through to `createAgent`:

```ts
import type { Agent, Middleware, ModelProvider, Sandbox, Tool } from "@lite-agent/core";
```
Add to `CreateLiteAgentConfig`:
```ts
  sandbox?: Sandbox;
```
Add to the `createAgent({ ... })` call:
```ts
    sandbox: cfg.sandbox,
```

- [ ] **Step 5: Update `packages/sdk/src/query.ts`**

Add `Sandbox` to the type import, a `sandbox?` option, and pass it through to `createLiteAgent`:

```ts
import type { AgentEvent, Message, Middleware, ModelProvider, RunResult, Sandbox, Tool } from "@lite-agent/core";
```
Add to `QueryOptions`:
```ts
  sandbox?: Sandbox;
```
Add to the `createLiteAgent({ ... })` call:
```ts
    sandbox: opts.sandbox,
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @lite-agent/sdk test`
Expected: PASS (all prior sdk tests + the new sandbox tests).
Run: `pnpm --filter @lite-agent/sdk typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): bash wraps commands via configured Sandbox; createLiteAgent/query sandbox option"
```

---

## Task 3: New package `@lite-agent/sandbox-anthropic` — `sandboxRuntime()` adapter

**Files:**
- Create: `packages/sandbox-anthropic/package.json`
- Create: `packages/sandbox-anthropic/tsconfig.json`
- Create: `packages/sandbox-anthropic/tsconfig.build.json`
- Create: `packages/sandbox-anthropic/src/index.ts`
- Test: `packages/sandbox-anthropic/test/sandboxRuntime.test.ts`

- [ ] **Step 1: Create `packages/sandbox-anthropic/package.json`**

```json
{
  "name": "@lite-agent/sandbox-anthropic",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "engines": { "node": ">=20" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean --tsconfig tsconfig.build.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sandbox-runtime": "^0.0.55",
    "@lite-agent/core": "workspace:*"
  },
  "devDependencies": { "@types/node": "^25.5.0", "tsup": "^8.3.0", "typescript": "^6.0.2", "vitest": "^2.1.0" }
}
```

- [ ] **Step 2: Create `packages/sandbox-anthropic/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "types": ["node"] },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `packages/sandbox-anthropic/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "ignoreDeprecations": "6.0" }
}
```

- [ ] **Step 4: Install**

Run: `pnpm install`
Expected: adds `@lite-agent/sandbox-anthropic`, installs `@anthropic-ai/sandbox-runtime` (no install scripts). Exit 0.

- [ ] **Step 5: Write the failing test** — `packages/sandbox-anthropic/test/sandboxRuntime.test.ts`

```ts
import { expect, test, vi } from "vitest";

const { initialize, wrapWithSandbox, reset } = vi.hoisted(() => ({
  initialize: vi.fn(async () => {}),
  wrapWithSandbox: vi.fn(async (cmd: string) => `SBX(${cmd})`),
  reset: vi.fn(async () => {}),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: { initialize, wrapWithSandbox, reset },
}));

import { sandboxRuntime } from "../src/index";

test("maps options, lazily initializes once, and wraps commands", async () => {
  const sb = sandboxRuntime({ allowedDomains: ["api.github.com"], denyRead: ["~/.ssh"], denyWrite: [".env"] });
  expect(sb.id).toBe("sandbox-runtime");

  expect(await sb.wrap("echo one", { cwd: "/w" })).toBe("SBX(echo one)");
  await sb.wrap("echo two", { cwd: "/w" });

  expect(initialize).toHaveBeenCalledTimes(1);
  expect(initialize.mock.calls[0]![0]).toMatchObject({
    network: { allowedDomains: ["api.github.com"], deniedDomains: [] },
    filesystem: { allowWrite: ["."], denyRead: ["~/.ssh"], denyWrite: [".env"] },
  });
  expect(wrapWithSandbox).toHaveBeenCalledTimes(2);

  await sb.dispose?.();
  expect(reset).toHaveBeenCalledTimes(1);
});

test("defaults: empty network, cwd-only write, sensible denyRead", async () => {
  const sb = sandboxRuntime();
  await sb.wrap("echo hi", { cwd: "/w" });
  expect(initialize.mock.calls.at(-1)![0]).toMatchObject({
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { allowWrite: ["."], denyRead: ["~/.ssh", "~/.aws"] },
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/sandbox-anthropic test`
Expected: FAIL — `sandboxRuntime` not found.

- [ ] **Step 7: Implement `packages/sandbox-anthropic/src/index.ts`**

```ts
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { Sandbox } from "@lite-agent/core";

export interface SandboxRuntimeOptions {
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowWrite?: string[];
  denyRead?: string[];
  denyWrite?: string[];
}

export function sandboxRuntime(opts: SandboxRuntimeOptions = {}): Sandbox {
  const config: SandboxRuntimeConfig = {
    network: { allowedDomains: opts.allowedDomains ?? [], deniedDomains: opts.deniedDomains ?? [] },
    filesystem: {
      allowWrite: opts.allowWrite ?? ["."],
      denyRead: opts.denyRead ?? ["~/.ssh", "~/.aws"],
      ...(opts.denyWrite ? { denyWrite: opts.denyWrite } : {}),
    },
  };
  let ready: Promise<void> | undefined;
  return {
    id: "sandbox-runtime",
    async wrap(command) {
      ready ??= SandboxManager.initialize(config);
      await ready;
      return SandboxManager.wrapWithSandbox(command);
    },
    dispose: () => SandboxManager.reset(),
  };
}
```

> If the installed `@anthropic-ai/sandbox-runtime` types name `SandboxRuntimeConfig`'s fields differently (e.g. `denyWrite` optionality), adjust the object to satisfy the real type — do NOT use `any`; read `node_modules/@anthropic-ai/sandbox-runtime/dist/*.d.ts` to confirm. The mapping behavior (and the test) must stay the same.

- [ ] **Step 8: Run test + typecheck + build**

Run: `pnpm --filter @lite-agent/sandbox-anthropic test`
Expected: PASS (2 tests).
Run: `pnpm --filter @lite-agent/sandbox-anthropic typecheck`
Expected: clean.
Run: `pnpm --filter @lite-agent/sandbox-anthropic build`
Expected: emits `dist/index.js` + `dist/index.d.ts`. Exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/sandbox-anthropic pnpm-lock.yaml
git commit -m "feat(sandbox-anthropic): sandboxRuntime() adapter over @anthropic-ai/sandbox-runtime"
```

---

## Final verification (after all tasks)

- [ ] `pnpm -r --filter "@lite-agent/core" --filter "@lite-agent/provider-anthropic" --filter "@lite-agent/sdk" --filter "@lite-agent/sandbox-anthropic" test` — all pass.
- [ ] `pnpm -r --filter "@lite-agent/*" typecheck` and root `pnpm typecheck` — clean.
- [ ] `pnpm -r --filter "@lite-agent/*" build` — all emit dist.
- [ ] Manual (optional, macOS/Linux with deps): wire `sandbox: sandboxRuntime({ allowedDomains: [...] })` into the CLI and confirm a denied-domain `curl` is blocked.
