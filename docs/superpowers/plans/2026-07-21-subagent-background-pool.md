# 同级子代理后台任务池实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在一个根 `LiteAgent` 实例中让 `Agent` 组统一后台执行，使用共享 FIFO 子代理池，并可靠地传递 display name、partial/失败状态和 terminal metadata。

**Architecture:** Core 只扩展通用后台任务的结构化结果与 `BackgroundStatus`；SDK 新增根实例拥有的 `SubagentPool`，`Agent` 工具把一次调用作为一个 detached 组并用 `Promise.allSettled` 聚合 child。`SessionRunner` 继续串行化 transcript 和后台唤醒，`query()` 在关闭临时 agent 前等待其后台组与 autonomous completion turn 收敛。

**Tech Stack:** TypeScript 6、pnpm 10.12.4、Vitest、Zod、现有 `@lite-agent/core` background registry、SDK session runner；不新增运行时依赖。

## Global Constraints

- Node >= 20，TypeScript strict/ESM，所有依赖包必须先 `pnpm -r build` 再测试依赖方。
- 长期 `createLiteAgent()` 会话中的 `Agent` 调用统一走 detached 后台组；`run_in_background` 仅保留兼容输入，不再选择同步/异步语义。
- 一个 `Agent` 调用是一个同级任务组；组内 child 全部 settle 后只产生一个聚合 completion，输入顺序必须稳定。
- `display_name` 是每个任务必填、非空且清理换行/控制字符；`subagent_type` 只做 definition 查找，`agentId` 只做运行身份。
- `maxParallelSubagents` 是根 `LiteAgent` 级配置，默认 5，与 `maxParallelTools`、`backgroundLimits` 分离；池采用 FIFO，并在 `close()` 时取消排队和运行中的 child。
- Child 继续 `agents: false`，不实现递归、Agent Teams、消息总线或跨进程 durable worker queue。
- `BackgroundCompletion.status` 是权威状态；`isError` 保留且在 status 非 `completed` 时为 `true`。旧字符串 background task 仍映射为成功。
- Child provider/codec/runtime 异常、`max_turns`、组取消、`stop` 空文本都不能被标成成功；混合成功/非成功必须是 `partial`。
- 每个任务先写失败测试并观察失败，再写最小实现；每个任务完成后独立运行其列出的测试并提交。

---

### Task 1: Core 结构化后台状态

**Files:**
- Modify: `packages/core/src/background.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/background.test.ts`

**Interfaces:**
- Produces `BackgroundStatus = "completed" | "partial" | "failed" | "cancelled"`。
- Produces `BackgroundRunResult = { content: string; status: BackgroundStatus }`。
- `BackgroundSpawnOptions.run` accepts `Promise<string | BackgroundRunResult>`；字符串保持旧行为并按 `completed` 处理。
- `BackgroundCompletion` 增加必填 `status`，保留 `isError`；`isError` 等价于 `status !== "completed"`。
- `backgroundCompletionMessage()` 对 `completed` 保持现有 XML，`partial` 输出 `status="partial"`，`failed` 输出 `status="error"`，`cancelled` 输出 `status="cancelled"`。

- [ ] **Step 1: Write the failing tests**

在 `background.test.ts` 增加：字符串结果得到 `{status:"completed", isError:false}`；结构化 `partial` 保留 status 且 `isError:true`；抛异常映射 `failed`；取消映射 `cancelled`；四种 status 的 XML 标签分别符合上述兼容格式。

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm --filter @lite-agent/core test -- background.test.ts`

Expected: 新增断言因 `BackgroundCompletion.status`/结构化结果尚不存在而失败，现有测试错误内容不应成为失败原因。

- [ ] **Step 3: Implement the minimal core change**

在 `createBackgroundTasks().finish()` 中统一归一化字符串与 `BackgroundRunResult`，异常直接构造成 `status:"failed"`；`cancel()` 只触发已有 signal，若任务正常返回取消结果由调用方提供 `cancelled`。更新 core 根导出与 XML formatter，保持既有 `label/content/isError` 字段和 detached buffer 行为不变。

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm --filter @lite-agent/core test -- background.test.ts`

Expected: 该文件全部通过，旧的 throw/limit/read 测试仍为绿色。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/background.ts packages/core/src/index.ts packages/core/test/background.test.ts
git commit -m "feat(core): add background completion status"
```

### Task 2: 根实例共享 FIFO `SubagentPool`

**Files:**
- Create: `packages/sdk/src/subagentPool.ts`
- Test: `packages/sdk/test/subagent-pool.test.ts`
- Modify: `packages/sdk/src/index.ts`

**Interfaces:**
- Produces `SubagentPool`：

```ts
export interface SubagentPool {
  run<T>(job: (signal: AbortSignal) => Promise<T>, parentSignal: AbortSignal): Promise<T>;
  pending(): { queued: number; running: number };
  close(): Promise<void>;
}
export function createSubagentPool(maxParallel: number): SubagentPool;
```

- `run()` 按提交顺序启动 job；`parentSignal` 在排队阶段触发时拒绝该 job，在运行阶段触发时 abort 传给 job；`close()` 拒绝所有未启动 job、abort 活跃 job，并等待活跃 Promise settle。

- [ ] **Step 1: Write the failing tests**

在 `subagent-pool.test.ts` 覆盖：上限为 2 时第三个 job 排队；释放第一个槽位后严格 FIFO；多个组提交仍共享同一上限；父 signal 取消排队/运行 job；`close()` 返回时 `pending()` 为零且不会遗留未处理 rejection。

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm --filter @lite-agent/sdk test -- subagent-pool.test.ts`

Expected: 模块不存在或导出不存在导致失败。

- [ ] **Step 3: Implement the minimal queue**

使用一个 FIFO 数组、`running` 计数和 `Set<Promise<void>>` 活跃任务；每次 settle 后泵出下一个任务。用 `AbortError`（从 `@lite-agent/core` 导入）表示池关闭/父 signal 取消，避免引入第二个并发库。

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm --filter @lite-agent/sdk test -- subagent-pool.test.ts`

Expected: 新测试全部通过，队列不会超过配置并发数。

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/subagentPool.ts packages/sdk/src/index.ts packages/sdk/test/subagent-pool.test.ts
git commit -m "feat(sdk): add shared subagent pool"
```

### Task 3: `Agent` 组契约、命名和结构化 child 结果

**Files:**
- Modify: `packages/sdk/src/tools/agent.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/agent-tool.test.ts`
- Test: `packages/sdk/test/agent-background.test.ts`

**Interfaces:**
- Produces：

```ts
export type SubagentStatus = "completed" | "failed" | "cancelled";
export interface SubagentResult {
  status: SubagentStatus;
  text?: string;
  error?: string;
  stopReason?: "stop" | "aborted" | "max_turns";
}
export type Spawn = (
  def: AgentDefinition,
  prompt: string,
  opts: SpawnOptions,
) => Promise<SubagentResult>;
```

- `agentTool({ loader, spawn, pool })` 必须接收 Task 2 的池；task schema 为 `display_name`、`subagent_type`、`prompt` 必填，`resume` 可选，旧 `run_in_background` 可解析但被忽略。
- `ctx.background` 缺失时必须明确拒绝执行并提示启用 background；不得回退为同步阻塞批次。
- 每个 synthetic `tool_use/tool_result` 的 `name` 使用清理后的 `display_name`，`input` 保留 `{ display_name, subagent_type, prompt }`；`agentId` 和 `resume` 语义不变。
- `runBatch()` 对 child 使用 `Promise.allSettled`，按输入顺序聚合：全成功 `completed`，全失败 `failed`，全取消 `cancelled`，其余混合 `partial`；聚合文本必须包含每项名称、agentId、状态、文本或错误。
- 无 definition、异常、非 `stop` stopReason、`stop` 空文本均生成非成功 `SubagentResult`，但不阻断兄弟任务。

- [ ] **Step 1: Update/add failing tests**

先把既有直接执行测试改为传 `display_name`，并增加断言：缺名/空名被 schema 拒绝；两个 `general-purpose` 用不同 display name 时 event/result 标题可区分；一个 child 失败且两个成功得到 `partial`；所有 child settle 后只出现一次 background completion；`max_turns`/空文本/throw 的外层 completion `isError:true`。

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm --filter @lite-agent/sdk test -- agent-tool.test.ts agent-background.test.ts`

Expected: 当前 schema 没有必填 `display_name`、局部 `p-limit` 和字符串 Spawn 合约使新增断言失败。

- [ ] **Step 3: Implement the group behavior**

移除 per-call `p-limit`；每个 child 调 `pool.run()`。所有测试上下文都通过 session-owned `ctx.background` 观察 placeholder/completion；缺少 registry 时抛出明确错误，绝不直接等待 batch。后台 `run` 返回 Task 1 的 `BackgroundRunResult`，并把 `run_in_background` 从描述和控制流中移除。

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm --filter @lite-agent/sdk test -- agent-tool.test.ts agent-background.test.ts`

Expected: 新增与既有命名、resume、事件转发测试全部通过，失败 child 不再把组标成成功。

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/tools/agent.ts packages/sdk/test/agent-tool.test.ts packages/sdk/test/agent-background.test.ts
git commit -m "feat(sdk): aggregate named subagent groups"
```

### Task 4: `createLiteAgent`、SessionRunner 与 `query()` 生命周期接线

**Files:**
- Modify: `packages/sdk/src/liteAgent.ts`
- Modify: `packages/sdk/src/createLiteAgent.ts`
- Modify: `packages/sdk/src/liteAgentAssembly.ts`
- Modify: `packages/sdk/src/sessionRunner.ts`
- Modify: `packages/sdk/src/query.ts`
- Test: `packages/sdk/test/subagents.test.ts`
- Test: `packages/sdk/test/session-background.test.ts`
- Test: `packages/sdk/test/query.test.ts`

**Interfaces:**
- `CreateLiteAgentConfig` 和 `QueryOptions` 增加 `maxParallelSubagents?: number`，默认 5，并完整转发。
- `SessionRunner` 增加 `awaitIdle(sessionId: string): Promise<void>`；当该 session 没有运行/排队后台组、没有 scheduled/draining completion 且 completion 队列为空时 resolve。
- `LiteAgent` 增加 `awaitIdle(sessionId?: string): Promise<void>` 作为 query 的有限生命周期适配；长期应用仍使用 `subscribe()`/`close()`。
- `createLiteAgent` 创建一个 pool，所有 `agentTool` 调用共享它；child `spawn` 返回 Task 3 的 `SubagentResult`：`stopReason:"stop"` 且非空文本才 completed，`max_turns`/`aborted`/空文本分别 failed/cancelled/failed，并保留错误消息。
- `close()` 先取消 session background scopes，再 `await pool.close()`；child 仍 `agents:false`。
- `query()` 在启动初始 user generator **之前**订阅该 session 的 background events，初始 generator 结束后排出事件并调用 `awaitIdle()` 等待所有组及 autonomous completion turn，然后返回最后一个 background `done.result`（无后台组则返回初始结果），最后才 `close()`；不会因临时 agent 关闭而取消尚未收拢的组。

- [ ] **Step 1: Write the failing integration tests**

增加/修改测试：两个 `Agent` 调用各三个任务共享 `maxParallelSubagents:2`；组完成只唤醒一次且可在期间提交用户回合；partial completion 持久化 `status="partial"`；child `max_turns`/空文本不成功；`background:false` 下 Agent 明确失败而不阻塞；`query()` 返回前等待 child 结果且 close 后无悬挂；`maxParallelSubagents` 从 query/config 传入。

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm --filter @lite-agent/sdk test -- subagents.test.ts session-background.test.ts query.test.ts`

Expected: 当前没有共享池、`Spawn` 丢失 stopReason、query finally 立即 close，因此至少并发上限、状态和 query 收拢测试失败。

- [ ] **Step 3: Implement lifecycle wiring**

在 `createLiteAgent` 根作用域创建 pool，并通过 `assembleLiteAgent` 注入 `agentTool`；给 SessionRunner 增加 idle waiters，在每次 schedule/settle/cancel 后唤醒判断。query 在启动 user run 前用现有订阅接口建立 background event queue，等待 idle 后按事件顺序 yield 并选择最后的 `done.result`。

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm --filter @lite-agent/sdk test -- subagents.test.ts session-background.test.ts query.test.ts`

Expected: 所有新增集成测试和原有 session/query 测试通过；长期 agent 在组运行期间不被阻塞，query 只在收拢后关闭。

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/liteAgent.ts packages/sdk/src/createLiteAgent.ts packages/sdk/src/liteAgentAssembly.ts packages/sdk/src/sessionRunner.ts packages/sdk/src/query.ts packages/sdk/test/subagents.test.ts packages/sdk/test/session-background.test.ts packages/sdk/test/query.test.ts
git commit -m "feat(sdk): wire pooled background subagents"
```

### Task 5: 文档、迁移说明与全量验证

**Files:**
- Modify: `packages/sdk/README.md`
- Modify: `packages/core/README.md`
- Modify: `docs-site/docs/en/sdk/tools/subagents.md`
- Modify: `docs-site/docs/zh/sdk/tools/subagents.md`
- Modify: `docs-site/docs/en/core/background.md`
- Modify: `docs-site/docs/zh/core/background.md`
- Modify: `packages/sdk/CHANGELOG.md`
- Modify: `packages/core/CHANGELOG.md`
- Test/verify: repository-wide build, test, typecheck commands

**Interfaces:** 文档必须说明必填 `display_name`、`subagent_type`/`agentId` 分工、组级一次送达、`partial`/错误状态、`maxParallelSubagents`、`createLiteAgent + subscribe/close` 与一次性 `query()` 的区别，以及不支持递归/Agent Teams。

- [ ] **Step 1: Add documentation assertions/examples**

在中英文子代理文档加入一个两组各三任务的 JSON 示例和 `partial` completion 示例；在 core 文档说明 `BackgroundStatus`/XML status；CHANGELOG 用现有英文格式记录 core/sdk 的 breaking-ish 0.x schema 扩展。

- [ ] **Step 2: Build all packages**

Run: `pnpm -r build`

Expected: 所有 package 的 ESM 与 d.ts 构建成功，包含新增 `SubagentPool`/`BackgroundStatus` 导出。

- [ ] **Step 3: Run all tests**

Run: `pnpm -r test`

Expected: 所有 Vitest workspace 测试通过，0 failed。

- [ ] **Step 4: Run all typechecks**

Run: `pnpm -r typecheck`

Expected: 所有 package `tsc --noEmit` 成功，无新增类型错误。

- [ ] **Step 5: Review diff and commit docs**

Run: `git diff --check && git status --short && git log --oneline -8`

Expected: 无空白错误；只包含本 spec 相关实现/测试/文档变更，然后提交：

```bash
git add packages/sdk/README.md packages/core/README.md docs-site/docs packages/sdk/CHANGELOG.md packages/core/CHANGELOG.md
git commit -m "docs: document pooled subagent lifecycle"
```
