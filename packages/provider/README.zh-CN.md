# @lite-agent/provider

[English](./README.md) | **简体中文**

lite-agent 的模型 Provider。一个包提供两种面向 [`@lite-agent/core`](../core) 的 `ModelProvider` 策略：

- **`anthropic()`** —— 把归一化请求映射到 [Anthropic Messages API](https://docs.claude.com/en/api/messages)（封装 `@anthropic-ai/sdk`）。
- **`openai()`** —— 映射到 [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat)（同时兼容 OpenAI 协议 / 本地端点）。

每个 provider 都会把 provider 的 SSE 翻译成 `ModelChunk`，把 SDK 错误包裹为 `ProviderError`（保留 `.status`），并暴露一个可注入的 `client` 接缝以便离线测试。

## 安装

```bash
pnpm add @lite-agent/provider
```

## 用法

把一个 provider 交给 [`@lite-agent/sdk`](../sdk) 的 `createLiteAgent` / `query`，或交给 core 的 `createAgent`：

```ts
import { anthropic, openai } from "@lite-agent/provider";

// Anthropic —— 默认从环境变量读取 ANTHROPIC_API_KEY 和 BASE_URL。
const claude = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.BASE_URL,
});

// OpenAI（或任意 OpenAI 兼容 / 本地端点，如 Ollama、vLLM、LM Studio）。
// 默认从环境变量读取 OPENAI_API_KEY 和 OPENAI_BASE_URL。
const gpt = openai({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "http://localhost:11434/v1", // 例如一个本地服务
});
```

```ts
import { query } from "@lite-agent/sdk";

for await (const ev of query({ prompt: "你好！", model: claude, modelName: "claude-sonnet-4-6" })) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

## 选项

`anthropic(opts)` 与 `openai(opts)` 都接受：

| 选项 | 说明 |
| --- | --- |
| `apiKey` | API key。缺省回退到 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。 |
| `baseURL` | 覆盖端点地址。缺省回退到 `BASE_URL` / `OPENAI_BASE_URL`。 |
| `client` | 注入自定义 / mock 客户端（结构化类型 —— 用于离线测试）。 |
| `maxRetries` | 底层 SDK 自身的重试次数。**默认 `0`**，使重试策略由 core 的 `retry()` 中间件掌管，避免两者叠加。 |

包的根部重导出这两个工厂函数及其选项类型（`AnthropicProviderOptions`、`OpenAIProviderOptions`），并在你需要时提供底层的 `toAnthropicParams` / `toOpenAIParams` / `translateStream` 映射函数。

架构说明见 [monorepo 根目录](../..)。
