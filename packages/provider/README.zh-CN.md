# @lite-agent/provider

[English](./README.md) | **简体中文**

lite-agent 的模型 Provider：开箱即用的 `ModelProvider` 策略，把 [`@lite-agent/core`](../core) 连接到 Anthropic Messages API 与 OpenAI Chat Completions（含 OpenAI 兼容及本地端点）。

## 安装

```bash
pnpm add @lite-agent/provider
```

## 快速开始

把一个 provider 交给 [`@lite-agent/sdk`](../sdk) 的 `query`（或 core 的 `createAgent`）：

```ts
import { anthropic } from "@lite-agent/provider";
import { query } from "@lite-agent/sdk";

// 默认从环境变量读取 ANTHROPIC_API_KEY 和 BASE_URL。
const claude = anthropic();

for await (const ev of query({ prompt: "你好！", model: claude, modelName: "claude-sonnet-4-6" })) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

```ts
import { openai } from "@lite-agent/provider";

// OpenAI 或任意 OpenAI 兼容端点（Ollama、vLLM、LM Studio 等）。
// 默认从环境变量读取 OPENAI_API_KEY 和 OPENAI_BASE_URL。
const gpt = openai({ baseURL: "http://localhost:11434/v1" });
```

## 特性

- **`anthropic()`** —— 把归一化请求映射到 [Anthropic Messages API](https://docs.claude.com/en/api/messages)，封装 `@anthropic-ai/sdk`。
- **`openai()`** —— 映射到 [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat)；同样适用于 OpenAI 兼容 / 本地端点。
- 把 provider 的 SSE 流翻译成归一化的 `ModelChunk`（文本增量、工具调用、usage）。
- 把 SDK 错误包裹为 `ProviderError`，保留 HTTP `.status`。
- 可注入的 `client` 接缝（结构化类型），便于用 mock 客户端做离线测试。
- `maxRetries` 默认 `0`，重试策略统一由 core 的 `retry()` 中间件掌管，避免两者叠加。
- 通过仓库内的离线共享合约测试；另提供显式启用的探测（`pnpm --filter @lite-agent/provider test:compat`），可按需验证其他 OpenAI 兼容端点。

## API

| 符号 | 说明 |
| --- | --- |
| `anthropic(options?)` | 创建面向 Anthropic Messages API 的 `ModelProvider`。 |
| `openai(options?)` | 创建面向 OpenAI Chat Completions 或兼容端点的 `ModelProvider`。 |
| `AnthropicProviderOptions`、`OpenAIProviderOptions` | 工厂选项：`apiKey` 与 `baseURL`（环境变量回退）、`client`、`maxRetries`。 |
| `AnthropicClientLike`、`OpenAIClientLike` | `client` 选项接受的结构化客户端类型。 |

## 相关

- [`@lite-agent/core`](../core) —— provider 无关的 agent 内核（策略、中间件、事件流）。
- [`@lite-agent/sdk`](../sdk) —— 高层 `query` / `createLiteAgent` API。
- [`@lite-agent/local`](../local) —— 本地运行时（Ollama、vLLM、LM Studio、llama.cpp）的维护预设。
- [monorepo 根目录](../..) —— 架构总览。
