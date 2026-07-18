# @lite-agent/core

lite-agent 的可插拔、事件驱动 agent 内核：一个精简、provider 无关的核心，由可替换的策略接口、洋葱中间件管道和类型化事件流构成。用它从原语出发搭建你自己的 agent——如果你想要开箱即用的完整方案（工具、技能、子代理、会话），请使用 [@lite-agent/sdk](/zh/packages/sdk)。

它的公开 API 参照 [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) 设计，但内核是自研的，因此也能通过可插拔的工具调用 codec 驱动本地小模型。

```bash
pnpm add @lite-agent/core zod
```

## 快速开始

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]),
  codec: nativeCodec(),
});

// Stream typed events…
for await (const ev of agent.run("hello")) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}

// …or await the final result.
const result = await agent.send("hello");
console.log(result.text);
```

`fakeProvider` 是内置的测试替身。接入真实模型时，传入来自 [@lite-agent/provider](/zh/packages/provider) 的 `ModelProvider`（`anthropic()` / `openai()`）。

## 内核轮次循环

`createAgent(config)` 把配置装配成 `KernelConfig`，返回一个带两个入口的 `Agent`：

- `run(input, opts?)` —— 异步生成器，产出每一个 `AgentEvent`，并最终返回 `RunResult`。
- `send(input, opts?)` —— 排空同一个生成器，只 resolve `RunResult`。

两者都通过 `RunOptions` 接受 `{ signal, sessionId, steer }`。内核一次运行的内部流程如下：

1. **加载会话。** 配置了 `checkpointer` 时，回放事件日志并用 `foldEvents` 重建消息列表；`crashRecovery: "safe"` 时，已开始但未完成的工具会补一条合成的错误 `tool_result`。
2. **运行 `beforeAgent` 钩子**（每次运行一次），随后排空事件队列。
3. **开启一轮** —— 产出 `turn_start`，应用待处理的 steer 和后台任务完成通知，然后运行 `beforeModel` 钩子（compaction 中间件就挂在这里）。
4. **调用模型。** 请求由 `ToolCallCodec` 编码，流经 `wrapModelCall` 中间件链，文本以 `text_delta` 事件透出。在产出任何 chunk 之前发生上下文溢出错误时，若 ContextEngine 处于激活状态，会触发一次紧急 compaction 并重试。
5. **解码响应。** codec 把 assistant 消息归一化为文本 + `ToolCall[]`。prompt codec 输出格式错误会抛 `CodecError`；内核追加 codec 的 `repairPrompt` 并重试（默认 2 次，由 `maxDecodeRetries` 控制）。
6. **停止或执行工具。** 没有工具调用 → `turn_end(stop)` 并退出循环（除非 steer/后台任务让它复活）。否则先按输入顺序产出全部 `tool_use` 事件，然后每个调用走 `wrapToolCall` 链——schema 校验、执行、转成 `ToolResult`。最多 `maxParallelTools`（默认 10）个并发执行；工具阶段事件按完成顺序实时流出，而面向模型的消息仍按输入顺序组装。
7. **回灌结果**：把所有结果块组装成一条 user 消息，产出 `turn_end(tool_use)`，继续循环——直到 `stop`、`aborted` 或达到 `maxTurns`。
8. **收尾。** 运行 `afterAgent` 钩子，产出携带 `RunResult`（`messages`、`text`、`usage`、`stopReason`）的 `done` 事件。

内核本身不懂权限和压缩——它们都是中间件。循环本体只剩「编码 → 调模型 → 解码 → 执行 → 回灌」。

:::tip
abort 只在轮次边界被观察：通过 `run(input, { signal })` 传入 `AbortSignal`，生成器会以 `done(reason: "aborted")` 收尾。
:::

## 事件与 drain 语义

每次运行产出一个单一的可辨识联合类型 `AgentEvent`：`turn_start`、`model_call_start`/`model_call_end`、`text_delta`、`message`、`tool_use`、`tool_call_start`/`tool_call_end`、`tool_result`、`approval_request`/`approval_resolved`、`input_request`/`input_resolved`、`permission_decision`、`compaction`、`context_status`、`steer`、`background_completed`、`turn_end`、`error`、`done` 等。从子代理转发来的事件会带 `agentId`。

消费或发送事件时有两条关键性质：

- **事件是观察性的，不是控制流。** 中间件和工具调用 `ctx.emit(ev)`；内核把这些事件缓冲进队列，在循环边界（钩子之后、模型调用之后、下一轮之前）统一 *drain*。emit 永远不会暂停循环，消费端再慢也不会阻塞内核。
- **交互 handler 自行阻塞自己的 I/O。** 当有 `ApprovalHandler` 或 `InputHandler` 参与时，内核先发出 `approval_request` / `input_request` 事件，然后 `await handler.request(...)`。循环确实停在这个 Promise 上——你的 CLI 读 stdin、web handler 等按钮点击——resolve 之后循环恢复。事件流和中断发生在同一进程内，提问过程中没有任何东西被持久化。

工具执行阶段，队列会被替换为实时 channel，使并发工具（以及转发的子代理事件）按完成顺序实时透出。

## 九种策略

内核的每个活动部件都是策略接口——每个角色一个实现，可热插拔。以下类型全部从 `@lite-agent/core` 导出。

### `ModelProvider`

为 `ModelRequest` 流式产出归一化的 `ModelChunk`（`text_delta` + 终止性的 `message_done`）。纯适配器：只懂厂商 API，不懂工具语义。还可暴露可选的 `context` 能力（`contextWindow`、`countTokens`、`clearToolUses`、`clearThinking`、`compact`、`promptCache`），ContextEngine 会优先使用它们而非本地 pass。

**自定义场景：** 把公司内部的推理网关包在 `stream()` 后面，整个内核——工具、checkpoint、中间件——原样可用。

### `ToolCallCodec`

把工具规格编码进请求，并把 assistant 消息解码回 `{ text, calls }`。基于 prompt 的 codec 声明 `streaming: "buffer"`，并可提供解码失败后使用的 `repairPrompt`。见[工具调用 codec](#工具调用-codec)。

**自定义场景：** 你微调的本地模型说一种自定义的 `<<tool:...>>` 语法——实现 `encode`/`decode` 插进来即可。

### `Tool`

zod 类型化的可调用体：`{ name, description, schema, security?, execute(input, ctx) }`。用 `defineTool` 定义，用 `toToolSpec` 转成面向模型的规格。内核在 `execute` 运行前先用 `schema` 校验输入；`ToolContext` 携带 `sessionId`、`signal`、`emit`，以及可选的 `approval` / `input` / `sandbox` / `background` 句柄。

```ts
import { defineTool } from "@lite-agent/core";
import { z } from "zod";

const weather = defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => `Sunny in ${city}`,
});
```

**自定义场景：** 把内部搜索 API 暴露成工具——五行代码，端到端全类型。

### `Compactor`

`maybeCompact(messages, usage, instructions?) → CompactResult`——决定是否以及如何压缩对话。`instructions` 用于引导手动 compaction（类似 Claude Code 的 `/compact <instructions>`）；结构性 compactor 会忽略它。见[上下文压缩](#上下文压缩)。

**自定义场景：** 一个领域感知的 compactor，永远保留提到未关闭 Jira 工单的消息。

### `PermissionPolicy`

`check(call, ctx) → "allow" | "deny" | "ask"`（或带规则溯源信息的 `PolicyVerdict`）。它只能看到身份标识——`ToolCall` 和 `sessionId`——拿不到 `emit` 和 `signal`。用 `policy`、`strictPolicy`、`composePolicies` 组合策略，用 `permission` 中间件把守执行。

**自定义场景：** 拒绝任何参数触及工作区之外文件的工具调用。

### `ApprovalHandler`

`request(call) → Promise<"allow" | "deny">`。当策略回答 `ask` 时被调用；循环一直停到你 resolve。拒绝会转成合成的 `isError` 工具结果——工具根本不会执行。

**自定义场景：** 在托管部署中把审批路由到 Slack 按钮。

### `InputHandler`

`request(question: UserQuestion) → Promise<UserAnswer>`。与审批对称的另一面：模型主动提问（通过 ask-user 工具），handler 用自由文本或选项作答。

**自定义场景：** 无头运行时，从配置文件读取答案而不是交互提问。

### `Store`

遗留的整组消息持久化接缝：`load(id)` / `save(id, messages)`。已被事件溯源的 [`Checkpointer`](#checkpointer-原语)取代；传入的 `Store` 会通过 `legacyStoreAdapter` 自动适配。

**自定义场景：** 你已经把对话记录存在 Postgres——保留你的 `Store`，内核会自动适配。

### `Sandbox`

把 shell 命令包进 OS 级边界运行：`wrap(command, { cwd })`，外加可选的 `initialize`/`dispose`。默认是 `noopSandbox()`——完全没有边界。真实的边界在 [@lite-agent/sandbox-anthropic](/zh/packages/sandbox-anthropic)。

**自定义场景：** 让所有 shell 工具命令跑在按会话创建的 Docker 容器里。

## 中间件：洋葱模型

一个 `Middleware` 可以实现生命周期钩子和两个包装器：

```ts
interface Middleware {
  name: string;
  beforeAgent?(ctx: AgentContext): void | Promise<void>;
  afterAgent?(ctx: AgentContext): void | Promise<void>;
  beforeModel?(ctx: AgentContext): void | Promise<void>;
  wrapModelCall?(ctx: AgentContext, next: ModelCall): AsyncIterable<ModelChunk>;
  wrapToolCall?(ctx: ToolCallContext, next: ToolExec): Promise<ToolResult>;
}
```

`composeModelCall` 和 `composeToolCall` 用 `reduceRight` 把中间件数组折叠在基础调用之外——**数组顺序即 外 → 内**。给定 `use: [a, b]`，一次模型调用的流向是 `a → b → provider → b → a`，经典洋葱。`runLifecycle` 只是按数组顺序依次运行钩子。`AgentContext` 是中间件拿到的唯一句柄：`sessionId`、可变的 `messages`、`turn`、`signal`、`emit`、共享的 `state` Map，以及用于持久化自定义事实的 `recordSessionEvent`。没有全局变量。

```ts
import type { Middleware } from "@lite-agent/core";

const logging: Middleware = {
  name: "logging",
  async *wrapModelCall(ctx, next) {
    console.time(`turn ${ctx.turn}`);
    yield* next();
    console.timeEnd(`turn ${ctx.turn}`);
  },
};

createAgent({ /* … */, use: [logging] });
```

内置中间件自证了这条接缝：`retry()`（带抖动退避的瞬态失败重试）、`compaction(compactor)`（在 `beforeModel` 中运行 `Compactor`）、`reactiveCompaction()`（捕获上下文溢出、裁剪、重试）、`permission(...)`（策略闸门）。它们都可以被重排、替换或移除。

## 工具调用 codec

codec 让内核在两个方向上都做到 provider 无关：同一个内核既能驱动带原生 function calling 的前沿 API，也能驱动靠 prompt 工程的本地 7B 模型。

| Codec | 协议 | 流式 | 适用场景 |
| --- | --- | --- | --- |
| `nativeCodec()` | 工具规格作为原生 `tools` 传入；调用以结构化 block 返回 | passthrough | provider 有真正的 function calling（Anthropic、OpenAI）。默认选择。 |
| `jsonCodec(opts?)` | 整段响应的 JSON 协议注入 `system`：`{"type":"tool_calls","calls":[…]}` 或 `{"type":"final","text":…}` | buffer | 模型指令遵循能力强但没有原生工具 API（多数本地模型）。 |
| `reactCodec(opts?)` | ReAct 文本：`Action:` / `Action Input:` / `Observation:` / `Final Answer:`，每次响应至多一个工具 | buffer | 对文本推理轨迹的解析比严格 JSON 更稳的小模型。 |

两种 prompt codec 都会把协议说明放进 system prompt，在 `encode` 时把历史改写成各自的文本格式，缓冲输出直到能干净解码，并提供 `repairPrompt`，让内核可以要求模型修复格式错误的输出而不是直接让运行失败（`maxDecodeRetries`，默认 2）。传入 `instructions` 可追加你自己的协议指引。

## 上下文压缩

两层机制，都可选且可组合：

**工具集** —— 确定性 pass 和现成的 `Compactor`：

| 符号 | 作用 |
| --- | --- |
| `compaction(compactor)` | `beforeModel` 中间件：运行 compactor 并换入结果，仅当消息真的变化时发出 `compaction` 事件。 |
| `defaultCompactor(opts?)` | 零 API 管道：`toolResultBudgetPass`（spill）→ `snipPass`（整段丢弃中间轮次，保留头部 + 尾部）→ `microPass`（把旧工具结果正文替换为占位符，保留最近 3 条）。所有切割都对齐轮次边界，tool_call/tool_result 配对保持完整。 |
| `llmCompactor(opts)` | 先跑确定性 base；仅当仍超过 `tokenThreshold` 时，用一次模型调用把较早的轮次总结成一条消息。熔断器（默认 2 次失败）会回退到 base，压缩永远不会卡死运行。 |
| `tokenBudgetCompactor(opts)` | 保留能塞进硬性 `maxTokens` 预算的最新轮次；更早的轮次用一条标记消息替代。 |
| `reactiveCompaction(opts?)` | 安全网：`wrapModelCall` 中间件，捕获上下文溢出错误，应用 `reactiveTrim`（无 LLM，自身永不溢出）并重试——仅在尚未流出任何内容时。 |
| `memorySpillStore()` / `toolResultBudgetPass(opts)` | spill 机制：工具结果正文合计超过 `budgetBytes` 时，最大的正文被移出上下文、存入 `SpillStore`，原地留下可检索的短标记（`SPILL_PREFIX`）。它在 micro *之前*运行，因此完整内容得以保留。 |
| `snipPass` / `microPass` / `splitTurns` / `runPipeline` / `estimateTokens` | 组装自定义 `CompactPass` 管道的构建块（可通过 `defaultCompactor({ passes })` 整体替换）。 |

**ContextEngine** —— 自动、常驻的上下文管理，当 `context` 不是 `false` 时由内核创建。它持有持久事件日志，为每次请求投影一个 `ContextView`，按内部压力等级逐级升级（externalize → normalize → select → project → recover），并把每次决策汇报为一个 `context_status` 事件。`ModelProvider` 暴露了 provider 原生能力（`clearToolUses`、`clearThinking`、`compact`）时优先使用，并通过 `KernelContextOptions` 接受 `planner` / `archive` 钩子。可用 `createContextEngine` 单独创建，或用 `projectContext` 自行投影视图。

:::info
`context` 省略时，底层 core 保持原始消息行为；[@lite-agent/sdk](/zh/packages/sdk) 默认传 `{}`，所以 SDK agent 开箱即有 ContextEngine。
:::

## Checkpointer 原语

会话持久化是事件溯源的。规范的持久化单元是 `SessionEvent`（`user`、`assistant`、`tool_started`、`tool_result`、`file_snapshot`、`artifact_verified`、`permission_decision`、`summary`、`context_view`），存储为带单调 `seq` 和 `parentSeq` 链接的 `StoredEvent`。

```ts
interface Checkpointer {
  append(sessionId: string, events: SessionEvent[], expectedHead?: number): Promise<number>;
  read(sessionId: string, opts?: { sinceSeq?: number }): AsyncIterable<StoredEvent>;
  head(sessionId: string): Promise<number>;
  list(): Promise<SessionInfo[]>;
  delete(sessionId: string): Promise<void>;
  truncate?(sessionId: string, toSeq: number): Promise<void>;
}
```

给 `append` 传 `expectedHead` 即获得乐观并发控制——不匹配时抛 `CheckpointConflictError`。因为日志是唯一事实来源，`truncate` + 回放就是时间旅行：从任意点分叉一个会话。

- `memoryCheckpointer()` —— 内存实现，用于测试和临时运行。持久化后端在 [@lite-agent/checkpoint-sqlite](/zh/packages/checkpoint-sqlite)。
- `foldEvents(events)` —— 从日志重建对话：连续的 `tool_result` 事件合并成一条 user 消息（复现内核的轮次形态），`summary` 事件会重置整个 transcript。
- `storeEvents(sessionId, fromSeq, events)` —— 把原始 `SessionEvent` 盖上 `seq`/`parentSeq`/`ts` 变成 `StoredEvent`；写自有后端时的构建块。
- `legacyStoreAdapter(store)` —— 把遗留的整组消息 `Store` 包成 `Checkpointer`，已有存储可继续工作。

## 错误类层次

所有内核错误都继承 `AgentError`，一次 `instanceof` 即可捕获整个家族：

| 类 | 触发时机 | 额外字段 |
| --- | --- | --- |
| `ProviderError` | provider 流失败（HTTP、网络、溢出） | `status?: number` |
| `ToolError` | 工具基础设施失败 | — |
| `CodecError` | prompt codec 无法解码模型输出 | — |
| `MaxTurnsError` | 超出轮次预算 | — |
| `AbortError` | 运行的 `AbortSignal` 触发 | — |
| `CheckpointConflictError` | `append` 遇到过期的 `expectedHead` | `sessionId`、`expected`、`actual` |

非致命失败（重试的模型调用、codec 修复尝试）在抛出之前会先以 `{ type: "error", fatal: false }` 事件出现，观察者能看到完整过程。

## 测试工具

- **`fakeProvider(turns)`** —— `ModelProvider` 测试替身，按脚本回放 `FakeTurn`（`{ text?, message, usage? }`）。确定性、无网络；上文快速开始里用的就是它。
- **`providerConformance`** —— 一组命名测试用例（文本顺序、恰好一个终止 `message_done`、错误映射为 `ProviderError`、abort），任何 `ModelProvider` 都必须通过。给它一个能按 `ProviderConformanceScenario` 构造你的 provider 的 `ProviderConformanceFactory`：

```ts
import { providerConformance } from "@lite-agent/core";

for (const test of providerConformance) {
  it(test.name, () => test.run((scenario) => makeMyProvider(scenario)));
}
```

- **`checkpointerConformance`** —— `Checkpointer` 后端的同款套件：单调 seq、`sinceSeq` 回放、冲突拒绝、list/delete、并发 append 串行化、payload 往返。[@lite-agent/checkpoint-sqlite](/zh/packages/checkpoint-sqlite) 就是用这套套件自验的。

```ts
import { checkpointerConformance } from "@lite-agent/core";

for (const test of checkpointerConformance) {
  it(test.name, () => test.run(() => myCheckpointer()));
}
```

## 相关

- [@lite-agent/sdk](/zh/packages/sdk) —— 由本内核组装的开箱即用 agent。
- [@lite-agent/provider](/zh/packages/provider) —— `ModelProvider` 实现（`anthropic()`、`openai()`）。
- [@lite-agent/checkpoint-sqlite](/zh/packages/checkpoint-sqlite) —— 持久化 `Checkpointer` 后端。
- [@lite-agent/sandbox-anthropic](/zh/packages/sandbox-anthropic) —— OS 级沙箱边界。
- [@lite-agent/local](/zh/packages/local) —— 本地模型支持。
- [快速上手](/zh/guide/getting-started) —— 构建你的第一个 agent。
