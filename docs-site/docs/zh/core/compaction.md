# 上下文压缩

长时间运行的 agent 迟早会撞上模型的上下文窗口。lite-agent 的上下文压缩能力在**不破坏 tool_call/tool_result 配对**的前提下缩小对话——所有切割都对齐轮次边界——并且分为两个可组合的层：一组以中间件形式接入的确定性工具集，以及一个替你管理上下文压力的自动化 ContextEngine。

## 开启压缩

用 `compaction()` 把 compactor 接入中间件管道，并加上 `reactiveCompaction()` 作为安全网：

```ts
import { createAgent, compaction, defaultCompactor, reactiveCompaction } from "@lite-agent/core";

const agent = createAgent({
  // model, codec, tools…
  use: [compaction(defaultCompactor()), reactiveCompaction()],
});
```

`compaction(compactor)` 在 `beforeModel` 中运行 compactor 并换入结果，实时发出开始、完成、错误或取消的 `compaction` 事件。`reactiveCompaction()` 捕获 provider 抛出的上下文溢出错误，裁剪上下文后重试——仅在尚未流出任何内容时。

:::info
基于 `@lite-agent/sdk` 构建时通常什么都不用配：SDK 默认传 `context: {}`，下面的 ContextEngine 已经激活。`context` 省略时，底层 core 保持原始消息行为。
:::

## 工具集

以下确定性 pass 和现成的 `Compactor` 全部从 `@lite-agent/core` 导出：

| 符号 | 作用 |
| --- | --- |
| `compaction(compactor)` | `beforeModel` 中间件：运行 compactor 并换入结果，实时发出开始、完成、错误或取消的 `compaction` 事件。 |
| `defaultCompactor(opts?)` | 零 API 管道：`toolResultBudgetPass`（spill）→ `snipPass`（整段丢弃中间轮次，保留头部 + 尾部）→ `microPass`（把旧工具结果正文替换为占位符，保留最近 3 条）。所有切割都对齐轮次边界，tool_call/tool_result 配对保持完整。 |
| `llmCompactor(opts)` | 先跑确定性 base；仅当仍超过 `tokenThreshold` 时，用一次模型调用把较早的轮次总结成一条消息。熔断器（默认 2 次失败）会回退到 base，压缩永远不会卡死运行。 |
| `tokenBudgetCompactor(opts)` | 保留能塞进硬性 `maxTokens` 预算的最新轮次；更早的轮次用一条标记消息替代。 |
| `reactiveCompaction(opts?)` | 安全网：`wrapModelCall` 中间件，捕获上下文溢出错误，应用 `reactiveTrim`（无 LLM，自身永不溢出）并重试——仅在尚未流出任何内容时。 |
| `memorySpillStore()` / `toolResultBudgetPass(opts)` | spill 机制：工具结果正文合计超过 `budgetBytes` 时，最大的正文被移出上下文、存入 `SpillStore`，原地留下可检索的短标记（`SPILL_PREFIX`）。它在 micro *之前*运行，因此完整内容得以保留。 |
| `snipPass` / `microPass` / `splitTurns` / `runPipeline` / `estimateTokens` | 组装自定义 `CompactPass` 管道的构建块（可通过 `defaultCompactor({ passes })` 整体替换）。 |

每个 compactor 都实现 `Compactor` 策略——`maybeCompact(messages, usage, instructions?) → CompactResult`。可选的 `instructions` 用于引导手动 compaction（类似 Claude Code 的 `/compact <instructions>`）；结构性 compactor 会忽略它。

## ContextEngine

ContextEngine 是自动、常驻的上下文管理，当 `context` 不是 `false` 时由内核创建。它持有持久事件日志，为每次请求投影一个 `ContextView`，按内部压力等级逐级升级（externalize → normalize → select → project → recover），并把每次决策汇报为一个 `context_status` 事件。`ModelProvider` 暴露了 provider 原生能力（`clearToolUses`、`clearThinking`、`compact`）时优先使用，并通过 `KernelContextOptions` 接受 `planner` / `archive` 钩子。

可用 `createContextEngine` 单独创建，或用 `projectContext` 自行投影视图。

## 另请参阅

- [九种策略](/zh/core/strategies)——`Compactor` 策略接口与自定义 compactor 场景。
- [模型提供方](/zh/core/providers)——哪些 provider 暴露原生上下文编辑能力。
- [会话持久化](/zh/core/persistence)——ContextEngine 所基于的事件日志。
- [工具调用 codec](/zh/core/codecs)——压缩后的历史如何被编码。

## 大内容与 SDK 自身的数据工作区

项目目录与 SDK 数据目录是两个范围。会话和归档位于 `<home>/projects/<project-hash>/`，通常在 `~/.lite-agent` 下，无需放进 `workdir`。`read_file` 可以读取工作区外当前会话已授权的归档／日志路径；普通写入仍限制在项目范围。该例外不会授予其他会话、其他项目或任意宿主机路径的访问权。

大文件在截断前完整保存 UTF-8 内容；其他超过 16 KiB 的工具结果也会在下次模型调用前归档。模型只收到稳定的 SHA-256 引用和简短预览。通过 `context({ ref, offset?, limit? })` 读取，并复制返回的 `nextOffset` 续读；这是字符游标，不是字节偏移。读取有上限、保持 Unicode 完整、标记为数据，并检查会话索引与符号链接替换。`read_spilled` 保留兼容别名，显式旧版 spill 配置仍使用原后端。

压缩生成派生视图，不销毁原始事件日志；旧片段先归档再缩短。当前片段和已确立的用户事实仍受保护，因此不能保证适配任意小的窗口。planner 有超时和确定性回退，取消时不提交半成品视图。SDK 归档内容与索引在返回引用前会执行刷盘。
