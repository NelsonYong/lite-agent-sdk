# 中间件

中间件让你在不改动内核的前提下为循环加横切行为：日志、重试、权限闸门、压缩。中间件是*加在轮次循环上的层*——内核把你的层折叠成经典洋葱，每层在进入时看到调用、在返回时看到结果。lite-agent 的权限和压缩本身就只是中间件，这自证了接缝：它们能做的，你自己的层也能做。

## 用法

通过 `createAgent` 的 `use` 传入中间件：

```ts
import { createAgent } from "@lite-agent/core";
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

## `Middleware` 接口

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

`AgentContext` 是中间件拿到的唯一句柄：`sessionId`、可变的 `messages`、`turn`、`signal`、`emit`、共享的 `state` Map，以及用于持久化自定义事实的 `recordSessionEvent`。没有全局变量。

## 洋葱模型：折叠顺序

`composeModelCall` 和 `composeToolCall` 用 `reduceRight` 把中间件数组折叠在基础调用之外——**数组顺序即 外 → 内**。给定 `use: [a, b]`，一次模型调用的流向是 `a → b → provider → b → a`。`runLifecycle` 只是按数组顺序依次运行钩子。

```
use: [A, B, C]
        │
   A ──► B ──► C ──► base tool/model call
   A ◄── B ◄── C ◄── result
```

数组中第一个中间件是最外层——进入时它最先看到调用，返回时最后看到结果。

## 内置中间件

| 中间件 | 作用 |
| --- | --- |
| `retry()` | 带抖动退避的瞬态失败重试。 |
| `compaction(compactor)` | 在 `beforeModel` 中运行 `Compactor` 并换入结果，仅当消息真的变化时发出 `compaction` 事件。见[上下文压缩](/zh/core/compaction)。 |
| `reactiveCompaction()` | `wrapModelCall` 安全网：捕获上下文溢出错误，应用 `reactiveTrim` 并重试——仅在尚未流出任何内容时。 |
| `permission(...)` | 策略闸门：`wrapToolCall` 在调用 `next()` 之前先向 `PermissionPolicy` 要裁决——`deny` 直接短路，`ask` 把调用挂起在 `ApprovalHandler` 上。 |

**权限就是一个中间件。** 门控没有任何硬编码进内核的部分；你可以像对待其他任何层一样重排、替换或移除这些层。

## 另请参阅

- [内核](/zh/core/kernel) —— 钩子何时触发、包装器包在哪一步。
- [策略](/zh/core/strategies) —— `PermissionPolicy`、`ApprovalHandler`、`Compactor` 等。
- [上下文压缩](/zh/core/compaction) —— compaction 中间件与 compactor 工具箱。
- [事件](/zh/core/events) —— 中间件可通过 `ctx.emit` 观察与发出的事件。
