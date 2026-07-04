# lite-agent

[English](./README.md) | **简体中文**

一个可插拔、轻量的 **Agent 内核 SDK**，以 pnpm monorepo 组织。内核与具体模型无关，由可替换的**策略（strategy）**接口 + 洋葱式**中间件（middleware）**管道 + 类型化的**事件（event）**流构成。其公开 API 参照 [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript)（`query` / `tool` / `allowedTools`）设计，但内核为自研，因此也能通过可插拔的 tool-call 编解码器（codec）驱动本地小模型。

## 包一览

| 包 | 说明 |
| --- | --- |
| [`@lite-agent/sdk`](./packages/sdk) | 开箱即用的 Agent：工具、技能（skills）、子 Agent、任务、会话、系统提示词 —— `query()` / `createLiteAgent()` / `tool()`。 |
| [`@lite-agent/core`](./packages/core) | 内核：策略接口、中间件管道、归一化类型、codec、权限、沙箱、checkpointer 原语。 |
| [`@lite-agent/provider`](./packages/provider) | 模型 Provider —— Anthropic Messages API + OpenAI Chat Completions（同时兼容 OpenAI 协议 / 本地端点）。 |
| [`@lite-agent/sandbox-anthropic`](./packages/sandbox-anthropic) | 操作系统级 `Sandbox` 适配器（macOS Seatbelt / Linux bubblewrap）。 |
| [`@lite-agent/checkpoint-sqlite`](./packages/checkpoint-sqlite) | SQLite（WAL）`Checkpointer` —— 单机、多进程的会话持久化。 |

以及 [`examples/cli`](./examples/cli) —— 一个串联整套能力的交互式 REPL 示例。

## 快速开始

```bash
pnpm add @lite-agent/sdk @lite-agent/provider zod
```

```ts
import { query } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

for await (const ev of query({
  prompt: "列出当前目录的文件，并总结这个项目是做什么的。",
  model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  modelName: "claude-sonnet-4-6",
  cwd: process.cwd(),
})) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

`createLiteAgent`、自定义工具、权限与会话等，见 [`@lite-agent/sdk`](./packages/sdk)。

## 架构

- **内核**（`core`）—— 每一轮：编码请求 → 从 provider 流式获取 → 解码出 tool 调用 → 每个调用穿过 tool-call 中间件链执行 → 把结果回灌 → 循环直到模型不再调用工具或达到 `maxTurns`。内核本身不关心权限、沙箱、压缩 —— 这些都是插进来的。
- **策略（Strategy）**——*替换某个部件*：`ModelProvider`、`ToolCallCodec`、`Tool`、`Compactor`、`PermissionPolicy`、`ApprovalHandler`、`InputHandler`、`Store`、`Sandbox`。
- **中间件（Middleware）**——*叠加一层*：重试、权限、日志、压缩 —— 通过 `wrapModelCall` / `wrapToolCall` 及生命周期钩子实现。
- **事件（Event）**——*只观察*：`run()` 产出的类型化 `AgentEvent` 流，用于日志 / UI / 指标。

## 开发

本仓库是一个 pnpm workspace（pnpm ≥ 10.12.4，Node ≥ 20）。在根目录执行：

```bash
pnpm build       # pnpm -r build —— 各包经 tsup 构建到 dist/（ESM + d.ts）
pnpm test        # pnpm -r test  —— vitest
pnpm typecheck   # pnpm -r typecheck
pnpm dev         # 运行交互式 CLI 示例
```

> 各包之间通过构建产物 `dist/` 相互引用，因此改动某个包的源码后，需先重新构建它再去测试依赖它的包。完整校验：`pnpm -r build && pnpm -r test && pnpm -r typecheck`。

## 许可协议

ISC
