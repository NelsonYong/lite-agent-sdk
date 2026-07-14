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

包根部导出两个工厂及其选项/客户端类型（`AnthropicProviderOptions`、
`AnthropicClientLike`、`OpenAIProviderOptions`、`OpenAIClientLike`）。请求映射器和
流转换器属于适配器内部实现，不是包根部的公共导出。

## 支持等级

| 等级 | 含义 |
| --- | --- |
| 维护中的适配器 | 仓库负责请求映射和流转换，并通过离线共享合约测试。 |
| 维护中的预设 | 仓库基于维护中的适配器提供端点/配置预设；具体能力仍取决于运行时和模型。 |
| 兼容端点 | 用户提供、预期实现相同协议的端点；在探测其确切运行时/模型组合前仅为尽力兼容。 |

| 集成 | 等级 | 说明 |
| --- | --- | --- |
| Anthropic Messages | 维护中的适配器 | 离线覆盖文本流、工具调用、归一化 usage、取消传播和 `ProviderError`。 |
| OpenAI Chat Completions | 维护中的适配器 | 应用相同的离线共享合约。 |
| Ollama、vLLM、LM Studio、llama.cpp | [`@lite-agent/local`](../local) 中维护的预设 | 复用 OpenAI 兼容适配器；原生工具和 usage 能力取决于运行时及模型。 |
| 其他 OpenAI 兼容端点 | 兼容端点 | 默认未经验证；请对确切端点和模型运行下面的探测。 |

“兼容”不是对所有实现的笼统认证。不同服务在流式输出、`stream_options`、
工具选择、usage 和错误行为上可能不同。

## 探测 OpenAI 兼容端点

该探测被明确排除在普通测试之外，只能通过专用命令运行：

```bash
LITE_AGENT_COMPAT_BASE_URL=http://127.0.0.1:11434/v1 \
LITE_AGENT_COMPAT_MODEL=qwen3:8b \
pnpm --filter @lite-agent/provider test:compat
```

`LITE_AGENT_COMPAT_API_KEY` 可选，默认值为 `local`。
`LITE_AGENT_COMPAT_FORCED_TOOL` 只接受 `true` 或 `false`（默认 `false`）；其他
非空值会在创建客户端前被拒绝。设置为 `true` 会增加一个强制调用具名 `echo`
工具的更强探测。通过该探测只证明具名强制工具选择可用，不代表所有原生工具选择
模式都可用。

两个适配器目前对流式工具 JSON 损坏的处理不同：Anthropic 会抛出 provider
错误；OpenAI 会退化为空输入对象，再由下游工具 schema 校验拒绝。

架构说明见 [monorepo 根目录](../..)。
