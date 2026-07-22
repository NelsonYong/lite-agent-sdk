# Model Tier Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an SDK-level catalog for `simple`, `medium`, and `complex` model profiles with provider/model metadata, a configurable `defaultModel`, and explicit per-subagent/per-task model selection while preserving the current single-model API.

**Architecture:** Keep routing in `@lite-agent/sdk`. A model resolver validates the legacy or tiered configuration and returns one resolved `{ provider, modelName, displayName, tier }` for each agent instance. The existing core kernel and provider interfaces continue to receive exactly one provider and one concrete request model; child agents reuse the root resolver and inherit or override the resolved profile.

**Tech Stack:** TypeScript 6 strict ESM, pnpm workspace, Vitest, `@lite-agent/core` `ModelProvider`, `@lite-agent/sdk` `createLiteAgent`/`query`/`Agent` tool, Markdown docs.

## Global Constraints

- Keep `@lite-agent/core` kernel, `ModelProvider`, `ModelRequest`, and provider mapping contracts unchanged.
- Preserve legacy `createLiteAgent({ model, modelName })`, `query({ model, modelName })`, and raw subagent `model` ids.
- Tiered configuration requires exactly `simple`, `medium`, and `complex` profiles and a `defaultModel` naming one of those tiers.
- A profile's `modelName` is the provider-facing model id; `displayName` is metadata only and defaults to `modelName` when omitted.
- Exact tier alias matches resolve through the catalog; every other subagent/task `model` string remains a raw model id on the inherited provider.
- Selection precedence is task override, then subagent definition, then current agent default, then root catalog default.
- Model tier must not change permissions, sandboxing, concurrency, context policy, or reasoning parameters in this implementation.
- Follow build-before-test choreography: rebuild changed packages before testing dependent packages; finish with `pnpm -r build`, `pnpm -r test`, `pnpm -r typecheck`, and `git diff --check`.

---

### Task 1: Add the model catalog types and resolver

**Files:**
- Create: `packages/sdk/src/modelCatalog.ts`
- Create: `packages/sdk/test/modelCatalog.test.ts`
- Modify: `packages/sdk/src/liteAgent.ts:41-44` to expose the catalog fields and internal runtime config type.
- Modify: `packages/sdk/src/index.ts:1-12` to export the public catalog types.

**Interfaces:**
- Produces `ModelTier`, `ModelProfile`, `ModelProfiles`, `ModelCatalog`, `ModelConfiguration`, `ResolvedModel`, `ModelResolver`, and `createModelResolver(config)` for later factory integration.
- `ModelResolver.defaultModel` is the root `ResolvedModel`; `ModelResolver.resolve(selection?: string, inherited?: ResolvedModel)` returns the selected model.

- [ ] **Step 1: Write failing resolver tests**

Create `packages/sdk/test/modelCatalog.test.ts` with deterministic providers and these behaviors:

```ts
import { expect, test } from "vitest";
import type { ModelProvider } from "@lite-agent/core";
import { createModelResolver } from "../src/modelCatalog";

const provider = (id: string): ModelProvider => ({
  id,
  async *stream() {},
});

const catalog = () => ({
  models: {
    simple: { provider: provider("simple-provider"), modelName: "fast-id", displayName: "Fast" },
    medium: { provider: provider("medium-provider"), modelName: "balanced-id", displayName: "Balanced" },
    complex: { provider: provider("complex-provider"), modelName: "strong-id", displayName: "Strong" },
  },
  defaultModel: "medium" as const,
});

test("resolves the configured default tier and each tier alias", () => {
  const resolver = createModelResolver(catalog());
  expect(resolver.defaultModel).toMatchObject({ tier: "medium", modelName: "balanced-id", displayName: "Balanced" });
  expect(resolver.resolve("simple")).toMatchObject({ tier: "simple", modelName: "fast-id" });
  expect(resolver.resolve("complex")).toMatchObject({ tier: "complex", modelName: "strong-id" });
});

test("inherits the current model when selection is omitted and preserves raw ids", () => {
  const resolver = createModelResolver(catalog());
  const inherited = resolver.resolve("complex");
  expect(resolver.resolve(undefined, inherited)).toBe(inherited);
  expect(resolver.resolve("raw-provider-id", inherited)).toMatchObject({
    provider: inherited.provider,
    modelName: "raw-provider-id",
    tier: undefined,
    displayName: "raw-provider-id",
  });
});

test("legacy single-model config resolves one provider and model id", () => {
  const legacy = provider("legacy-provider");
  const resolver = createModelResolver({ model: legacy, modelName: "legacy-id" });
  expect(resolver.defaultModel).toMatchObject({ provider: legacy, modelName: "legacy-id", displayName: "legacy-id" });
});

test("rejects incomplete catalogs, invalid defaults, and empty model ids", () => {
  expect(() => createModelResolver({ models: { simple: catalog().models.simple } as never, defaultModel: "simple" })).toThrow(/simple.*medium.*complex|profiles/i);
  expect(() => createModelResolver({ ...catalog(), defaultModel: "unknown" as never })).toThrow(/defaultModel/i);
  expect(() => createModelResolver({ ...catalog(), models: { ...catalog().models, simple: { provider: provider("p"), modelName: "" } } })).toThrow(/modelName/i);
});
```

- [ ] **Step 2: Run the resolver tests and verify the expected RED failure**

Run:

```bash
pnpm --filter @lite-agent/sdk test -- modelCatalog.test.ts
```

Expected: Vitest fails because `packages/sdk/src/modelCatalog.ts` and the new types do not exist yet. Fix only test syntax/import errors if present; do not add production implementation before observing the feature-missing failure.

- [ ] **Step 3: Implement the minimal catalog resolver**

In `packages/sdk/src/modelCatalog.ts`, add:

```ts
import type { ModelProvider } from "@lite-agent/core";

export const MODEL_TIERS = ["simple", "medium", "complex"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export type ModelProfile = {
  provider: ModelProvider;
  modelName: string;
  displayName?: string;
};

export type ModelProfiles = Record<ModelTier, ModelProfile>;

export type ModelCatalog = {
  models: ModelProfiles;
  defaultModel: ModelTier;
};

export type ModelConfiguration = {
  model?: ModelProvider;
  modelName?: string;
  models?: ModelProfiles;
  defaultModel?: ModelTier;
};

export type ResolvedModel = {
  provider: ModelProvider;
  modelName: string;
  displayName: string;
  tier?: ModelTier;
};

export type ModelResolver = {
  readonly defaultModel: ResolvedModel;
  resolve(selection?: string, inherited?: ResolvedModel): ResolvedModel;
};

export function createModelResolver(config: ModelConfiguration): ModelResolver {
  // Validate exactly the three tier keys, provider presence, non-empty ids, and
  // defaultModel. Legacy config produces one resolved profile and keeps its
  // provider for raw child model ids.
}
```

Use small private helpers for `isModelTier`, `profileToResolved`, and exact key validation. Throw `AgentError` with messages naming `model`, `models`, `modelName`, or `defaultModel` so configuration failures are actionable. A tiered resolver must return the inherited resolved profile when selection is omitted; a raw selection must retain the inherited provider and use the raw string as both id and fallback display name.

- [ ] **Step 4: Run the resolver tests and verify GREEN**

Run the same Vitest command. Expected: all resolver tests pass with no warnings.

- [ ] **Step 5: Wire and export the public types without changing runtime behavior**

In `packages/sdk/src/liteAgent.ts`, import `ModelConfiguration` and add its four optional model fields to `CreateLiteAgentConfig`; make the legacy `model` and `modelName` fields optional because tiered configuration supplies providers inside each profile. Existing legacy callers remain source-compatible because their values are still accepted at runtime. Add the internal type used by assembly:

```ts
export type RuntimeLiteAgentConfig = Omit<CreateLiteAgentConfig, "model" | "modelName"> & {
  model: ModelProvider;
  modelName: string;
};
```

In `packages/sdk/src/index.ts`, export `ModelTier`, `ModelProfile`, `ModelProfiles`, `ModelCatalog`, and `ModelConfiguration`; do not expose the resolver function as a package API yet. Update `packages/local/src/index.ts` later in Task 2 so strict local assembly does not accept a tiered catalog accidentally.

- [ ] **Step 6: Run SDK typecheck and resolver tests**

Run:

```bash
pnpm --filter @lite-agent/sdk typecheck
pnpm --filter @lite-agent/sdk test -- modelCatalog.test.ts
```

Expected: typecheck succeeds and all resolver tests pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add packages/sdk/src/modelCatalog.ts packages/sdk/test/modelCatalog.test.ts packages/sdk/src/liteAgent.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): add model tier catalog resolver"
```

### Task 2: Resolve the catalog at agent/query assembly

**Files:**
- Modify: `packages/sdk/src/createLiteAgent.ts:18-93` to create one resolver and pass one active resolved model to each runtime instance.
- Modify: `packages/sdk/src/liteAgentAssembly.ts:34-40,150-180,244-310` to consume `RuntimeLiteAgentConfig` and use the resolved provider/model id for system/context setup.
- Modify: `packages/sdk/src/query.ts:28-90` to accept and forward tiered model fields.
- Modify: `packages/local/src/index.ts:37-50` to omit tiered fields from the strict single-host config.
- Create: `packages/sdk/test/modelRouting.test.ts`

**Interfaces:**
- Consumes `createModelResolver` and `RuntimeLiteAgentConfig` from Task 1.
- Produces a root `createLiteAgent`/`query` path where a tiered config sends the selected profile's provider and model id into the existing kernel.

- [ ] **Step 1: Write failing root/query integration tests**

Create a recorder provider helper that captures `ModelRequest.model` and returns one assistant text response. Add tests for:

```ts
test("createLiteAgent uses defaultModel profile provider and model id", async () => {
  const seen: string[] = [];
  const simple = recordingProvider("simple", seen);
  const medium = recordingProvider("medium", seen);
  const complex = recordingProvider("complex", seen);
  const agent = createLiteAgent({
    models: {
      simple: { provider: simple, modelName: "fast-id", displayName: "Fast" },
      medium: { provider: medium, modelName: "balanced-id", displayName: "Balanced" },
      complex: { provider: complex, modelName: "strong-id", displayName: "Strong" },
    },
    defaultModel: "complex",
    workdir: process.cwd(),
    sessions: false,
    cleanup: false,
    agents: false,
    tasks: false,
    background: false,
  });
  await agent.send("hello");
  expect(seen).toEqual(["strong-id"]);
  await agent.close();
});

test("query forwards models and defaultModel", async () => {
  const seen: string[] = [];
  const gen = query({
    prompt: "hello",
    models: {
      simple: { provider: recordingProvider("simple", seen), modelName: "fast-id" },
      medium: { provider: recordingProvider("medium", seen), modelName: "balanced-id" },
      complex: { provider: recordingProvider("complex", seen), modelName: "strong-id" },
    },
    defaultModel: "simple",
    cwd: process.cwd(),
    sessions: false,
    cleanup: false,
    agents: false,
    tasks: false,
    background: false,
  });
  while (!(await gen.next()).done) {}
  expect(seen).toEqual(["fast-id"]);
});
```

Also retain a legacy test using `{ model, modelName }` and assert the captured request remains unchanged.

- [ ] **Step 2: Run the integration tests and verify RED**

Run:

```bash
pnpm --filter @lite-agent/sdk test -- modelRouting.test.ts
```

Expected: type errors or runtime failures show that `createLiteAgent`/`query` do not yet accept or resolve `models`/`defaultModel`.

- [ ] **Step 3: Implement root model resolution and runtime config**

Refactor `packages/sdk/src/createLiteAgent.ts` into a public wrapper and a private recursive helper:

```ts
export function createLiteAgent(cfg: CreateLiteAgentConfig): LiteAgent {
  const resolver = createModelResolver(cfg);
  return createLiteAgentInstance(cfg, resolver, resolver.defaultModel);
}

function createLiteAgentInstance(
  source: CreateLiteAgentConfig,
  resolver: ModelResolver,
  active: ResolvedModel,
): LiteAgent {
  const cfg: RuntimeLiteAgentConfig = {
    ...source,
    model: active.provider,
    modelName: active.modelName,
  };
  // Existing cleanup, session, pool, assembly, and facade setup continues to
  // use cfg. The child spawn hook is completed in Task 3.
}
```

Do not mutate the caller's config. The internal runtime config must always give `assembleLiteAgent` a concrete `model` and `modelName`, regardless of whether the caller used legacy or tiered configuration.

Update `assembleLiteAgent`'s `cfg` type to `RuntimeLiteAgentConfig`. Its existing `buildSystemPrompt`, codec static prefix, `createAgent`, and `ContextEngine` calls should continue reading `cfg.model` and `cfg.modelName`; those values now come from the selected profile.

Update `QueryOptions` to make `model` optional for tiered calls, add `models?: ModelProfiles` and `defaultModel?: ModelTier`, and forward all four fields to `createLiteAgent`.

Update `StrictOmissions` in `packages/local/src/index.ts` with `"models" | "defaultModel"` so `@lite-agent/local` remains the strict single-model assembly and cannot silently ignore a catalog.

- [ ] **Step 4: Run the integration tests and verify GREEN**

First rebuild the changed SDK package, then run:

```bash
pnpm --filter @lite-agent/sdk build
pnpm --filter @lite-agent/sdk test -- modelRouting.test.ts
pnpm --filter @lite-agent/sdk typecheck
pnpm --filter @lite-agent/local typecheck
```

Expected: tiered root/query requests use the configured provider and model id; legacy tests remain green.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/sdk/src/createLiteAgent.ts packages/sdk/src/liteAgentAssembly.ts packages/sdk/src/query.ts packages/sdk/src/liteAgent.ts packages/sdk/src/index.ts packages/local/src/index.ts packages/sdk/test/modelRouting.test.ts
git commit -m "feat(sdk): resolve configured model tiers at assembly"
```

### Task 3: Add explicit task and subagent model overrides

**Files:**
- Modify: `packages/sdk/src/tools/agent.ts:19-46,170-215` to accept `tasks[].model` and pass it through `SpawnOptions`.
- Modify: `packages/sdk/src/createLiteAgent.ts:45-75` to resolve task/definition selections against the current active model and construct children with the selected profile.
- Modify: `packages/sdk/src/agents/types.ts:6-10` documentation to describe tier aliases plus raw model ids.
- Modify: `packages/sdk/test/agent-tool.test.ts` with schema/forwarding coverage.
- Modify: `packages/sdk/test/modelRouting.test.ts` with end-to-end precedence coverage.

**Interfaces:**
- `SpawnOptions` gains `model?: string`.
- `Spawn` remains `(definition, prompt, opts)`; existing callers that ignore the new option continue to compile.
- The task schema keeps `model` as `z.string().optional()` to preserve raw model id compatibility.

- [ ] **Step 1: Write failing task-forwarding and precedence tests**

In `agent-tool.test.ts`, add:

```ts
test("forwards an explicit task model selection to spawn", async () => {
  let selected: string | undefined;
  const tool = toolWith(loaderWith("worker"), async (_def, _prompt, opts) => {
    selected = opts.model;
    return completed("ok");
  });
  const { ctx, bg } = ctxWithBackground();
  await tool.execute({ tasks: [{ display_name: "Worker", subagent_type: "worker", prompt: "go", model: "complex" }] }, ctx);
  await completion(bg);
  expect(selected).toBe("complex");
});
```

In `modelRouting.test.ts`, add one integration test with three recording providers and a temporary agent definition whose frontmatter says `model: simple`. Drive the parent fake provider through three `Agent` calls and assert:

```text
task model complex + definition simple + root medium -> complex model id
no task model + definition simple + root medium       -> simple model id
no task/definition model + root medium                -> medium model id
```

Use separate provider recorder arrays so the assertion proves provider selection, not only the request string.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
pnpm --filter @lite-agent/sdk test -- agent-tool.test.ts modelRouting.test.ts
```

Expected: the task schema/SpawnOptions test fails because `model` is not forwarded and the child integration still always uses the parent `modelName`/raw definition behavior.

- [ ] **Step 3: Implement task selection and child inheritance**

In `packages/sdk/src/tools/agent.ts`:

```ts
export interface SpawnOptions {
  signal: AbortSignal;
  sessionId: string;
  model?: string;
  onEvent?: (e: AgentEvent) => void;
}

const TASK = z.object({
  display_name: z.string().refine(hasVisibleDisplayName, "display_name must contain visible characters"),
  subagent_type: z.string(),
  prompt: z.string(),
  model: z.string().optional(),
  resume: z.string().optional(),
});
```

Pass `child.task.model` in the existing `spawn` call as `model: child.task.model`.

In `createLiteAgent.ts`, share the root `ModelResolver` with recursive child creation. Resolve with:

```ts
const selected = resolver.resolve(model ?? definition.model, active);
const child = createLiteAgentInstance(
  {
    ...source,
    system: `You are the "${definition.name}" subagent operating in ${source.workdir}. ` +
      `Return your final answer as your last message.\n\n${definition.body}`,
    allowedTools: definition.tools ?? source.allowedTools,
    agents: false,
    tools: source.tools?.filter((tool) => tool.name !== "Agent"),
    cleanup: false,
    permission: source.subagentPermission,
    onApproval: undefined,
    onAskUser: undefined,
    outputSchema: undefined,
    checkpointer: source.checkpointer,
  },
  resolver,
  selected,
);
```

The `model` parameter comes from `SpawnOptions`; when it is absent, `definition.model` is used. When both are absent, `resolver.resolve(undefined, active)` returns the current active profile so grandchildren inherit the selected tier. Raw ids use `active.provider`; tier aliases can switch provider through the catalog.

Update the `AgentDefinition.model` comment to say it accepts a configured tier alias or a raw provider model id.

- [ ] **Step 4: Run the task and integration tests and verify GREEN**

Run:

```bash
pnpm --filter @lite-agent/sdk build
pnpm --filter @lite-agent/sdk test -- agent-tool.test.ts modelRouting.test.ts subagents.test.ts
pnpm --filter @lite-agent/sdk typecheck
```

Expected: explicit task override, definition default, root default, raw model compatibility, and existing subagent lifecycle tests all pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add packages/sdk/src/tools/agent.ts packages/sdk/src/createLiteAgent.ts packages/sdk/src/agents/types.ts packages/sdk/test/agent-tool.test.ts packages/sdk/test/modelRouting.test.ts
git commit -m "feat(sdk): route subagent tasks by model tier"
```

### Task 4: Document the public API and run the full verification matrix

**Files:**
- Modify: `packages/sdk/README.md` in the getting-started/configuration section.
- Modify: `packages/sdk/README.zh-CN.md` in the corresponding Chinese section.
- Modify: `docs-site/docs/en/sdk/tools/subagents.md` with tier inheritance and task override examples.
- Modify: `docs-site/docs/zh/sdk/tools/subagents.md` with the same examples and rubric.
- Test: existing SDK, local, provider, and core suites through the repository commands below.

**Interfaces:**
- Documents the exact `models`/`defaultModel` shape, `displayName` semantics, selection precedence, and the fact that automatic classification/escalation is not enabled yet.

- [ ] **Step 1: Add concise English and Chinese examples**

Document this exact public shape:

```ts
createLiteAgent({
  models: {
    simple: { provider: fast, modelName: "fast-id", displayName: "Fast" },
    medium: { provider: balanced, modelName: "balanced-id", displayName: "Balanced" },
    complex: { provider: strong, modelName: "strong-id", displayName: "Strong" },
  },
  defaultModel: "medium",
  workdir,
});
```

Explain that `Agent` task `model` overrides agent-definition `model`, which overrides the current/default tier; arbitrary non-tier strings remain raw model ids for compatibility. Include the simple/medium/complex task rubric from the design spec and explicitly keep permissions and reasoning effort independent.

- [ ] **Step 2: Build the docs site and SDK package**

Run:

```bash
pnpm --filter @lite-agent/sdk build
pnpm docs:build
```

Expected: both commands exit 0 and generated output contains no TypeScript or Rspress errors.

- [ ] **Step 3: Run focused and full verification**

Run in this order:

```bash
pnpm --filter @lite-agent/sdk test
pnpm --filter @lite-agent/local test
pnpm -r build
pnpm -r test
pnpm -r typecheck
git diff --check
git status --short
```

Record any repository-baseline failure separately from failures caused by this feature; do not claim completion without the exact command output.

- [ ] **Step 4: Commit documentation and final changes**

```bash
git add packages/sdk/README.md packages/sdk/README.zh-CN.md docs-site/docs/en/sdk/tools/subagents.md docs-site/docs/zh/sdk/tools/subagents.md
git commit -m "docs: document model tier routing"
```
