# @lite-agent/provider

lite-agent 的模型提供方包：开箱即用的 `ModelProvider` 策略，把 [`@lite-agent/core`](/zh/packages/core) 连接到 Anthropic Messages API 和 OpenAI Chat Completions —— 包括 OpenAI 兼容端点和本地端点。

## 安装

```bash
pnpm add @lite-agent/provider
```

## 快速开始

把 provider 交给 [`@lite-agent/sdk`](/zh/packages/sdk) 的 `query`（或 core 的 `createAgent`）：

```ts
import { anthropic } from "@lite-agent/provider";
import { query } from "@lite-agent/sdk";

// Reads ANTHROPIC_API_KEY and BASE_URL from env by default.
const claude = anthropic();

for await (const ev of query({ prompt: "Hello!", model: claude, modelName: "claude-sonnet-4-6" })) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

```ts
import { openai } from "@lite-agent/provider";

// OpenAI or any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, ...).
// Reads OPENAI_API_KEY and OPENAI_BASE_URL from env by default.
const gpt = openai({ baseURL: "http://localhost:11434/v1" });
```

## `anthropic(options?)`

创建一个 `ModelProvider`（`id: "anthropic"`），把规范化请求映射到 [Anthropic Messages API](https://docs.claude.com/en/api/messages)，内部封装 `@anthropic-ai/sdk`。

### 选项 —— `AnthropicProviderOptions`

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `apiKey` | `string` | `process.env.ANTHROPIC_API_KEY` | 传给 Anthropic SDK 的 API key。 |
| `baseURL` | `string` | `process.env.BASE_URL` | 端点覆盖（代理、网关等）。 |
| `maxRetries` | `number` | `0` | Anthropic SDK 自身的重试次数。见**重试**。 |
| `client` | `AnthropicClientLike` | — | 注入预构建或伪造的 client，而不是由工厂创建。见**离线测试：注入 client**。 |

返回的 provider 还会声明 `context` 能力：自动 prompt 缓存、`countTokens`，以及 —— 当 client 存在 `beta.messages.create` 接口时 —— Anthropic 原生的上下文编辑（`clearToolUses`、`clearThinking`、`compact`）。

:::tip 自定义请求头
本包没有 `headers` 选项。如需设置默认请求头、超时等 SDK 配置，请自行构造 Anthropic client 并通过 `client` 传入：

```ts
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@lite-agent/provider";

const client = new Anthropic({ defaultHeaders: { "x-trace-id": "..." } });
const claude = anthropic({ client });
```
:::

## `openai(options?)`

创建一个 `ModelProvider`（`id: "openai"`），把规范化请求映射到 [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat)，内部封装 `openai` SDK。由于整个协议族共享同一套 wire 格式，同一适配器也可用于 OpenAI 兼容端点和本地端点。

### 选项 —— `OpenAIProviderOptions`

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `apiKey` | `string` | `process.env.OPENAI_API_KEY` | 传给 OpenAI SDK 的 API key。多数本地服务接受任意非空字符串。 |
| `baseURL` | `string` | `process.env.OPENAI_BASE_URL` | 端点覆盖 —— 指向 OpenAI 兼容服务器就靠它。 |
| `maxRetries` | `number` | `0` | OpenAI SDK 自身的重试次数。见**重试**。 |
| `client` | `OpenAIClientLike` | — | 注入预构建或伪造的 client。见**离线测试：注入 client**。 |

## OpenAI 兼容与本地端点

`openai()` 接受任何实现了 Chat Completions 的服务器。把 `baseURL` 指向服务器的 `/v1` 根路径即可：

```ts
import { openai } from "@lite-agent/provider";

// Ollama — https://ollama.com
const ollama = openai({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });

// vLLM — `vllm serve <model>`
const vllm = openai({ baseURL: "http://localhost:8000/v1", apiKey: "local" });

// LM Studio — local server tab
const lmStudio = openai({ baseURL: "http://localhost:1234/v1", apiKey: "lm-studio" });

// llama.cpp — `llama-server`
const llamaCpp = openai({ baseURL: "http://localhost:8080/v1", apiKey: "local" });
```

:::tip 受维护的本地预设
对于回环（loopback）运行时，建议优先使用 [`@lite-agent/local`](/zh/packages/local)：`localOpenAI` 内置 `ollama`、`vllm`、`lm-studio`、`llama.cpp` 预设，强制仅回环端点，并在启动时做健康探测。
:::

:::warning 能力随运行时和模型而异
Chat Completions 传输层能通，不代表每个端点对每个模型都支持原生工具调用或 usage 上报。见**兼容性等级** —— 用**探测端点**验证具体的端点/运行时/模型组合。
:::

## 流式翻译：SSE → `ModelChunk`

每个适配器的核心职责，是把提供方的 SSE 事件流翻译成 `@lite-agent/core` 的规范化 `ModelChunk` 联合类型：

```ts
type ModelChunk =
  | { type: "text_delta"; text: string }
  | { type: "message_done"; message: AssistantMessage; usage: Usage };
```

翻译器保证的行为：

- 文本增量按源顺序流出；拼接结果等于最终的 text 块。
- 工具调用从提供方原生的参数碎片中累积，输出为规范化的 `{ type: "tool_call", id, name, input }` 块，`input` 为解析后的 JSON。
- 一次成功的流恰好以一个 `message_done` 结尾，携带完整的 `AssistantMessage` 和 `Usage`（`inputTokens` / `outputTokens`）。

值得注意的适配器差异：

- **Anthropic** 还会在上报时把 `cacheReadTokens` / `cacheCreationTokens` 带进 `usage`，支持 `compaction` 内容块，未知块类型包装为 `{ type: "native", provider: "anthropic", data }`。工具调用 JSON 解析失败会抛错。
- **OpenAI** 按 `index` 组装工具调用，参数 JSON 解析失败时回退为 `{}`。

## 错误处理

两个适配器都会捕获 SDK 错误并重新抛出为 `ProviderError`（来自 `@lite-agent/core`），在可用时保留数值型 HTTP 状态码：

```ts
import { ProviderError } from "@lite-agent/core";

try {
  for await (const ev of query({ prompt: "Hi", model: anthropic(), modelName: "claude-sonnet-4-6" })) { /* ... */ }
} catch (e) {
  if (e instanceof ProviderError) {
    console.error(e.message, e.status); // e.g. 401, 429, 500 — or undefined for non-HTTP failures
  }
}
```

输出前的失败和流式迭代中途的失败都遵循这一约定，因此 core 的 `retry()` 中间件可以统一分类处理。

## 重试

两个适配器的 `maxRetries` 都默认 `0`，这是有意为之：重试策略由 core 的 `retry()` 中间件统一掌管，SDK 层的重试会与之叠加放大。只有当你确实想让 SDK 自行重试时，才显式设置 `maxRetries`。

## 离线测试：注入 client

两个工厂都接受一个只需满足小型结构化类型的 `client` —— `AnthropicClientLike`（`messages.create` 返回原始流事件的异步可迭代对象）或 `OpenAIClientLike`（`chat.completions.create` 返回 chunk 流）。这让测试完全确定性、零网络：

```ts
import { openai } from "@lite-agent/provider";
import type { OpenAIClientLike } from "@lite-agent/provider";

async function* fakeChunks() {
  yield { choices: [{ delta: { content: "Hello" } }] };
  yield { choices: [{ delta: { content: ", world" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
}

const client: OpenAIClientLike = {
  chat: { completions: { create: async () => fakeChunks() } },
};

const provider = openai({ client });
const chunks = [];
for await (const c of provider.stream({ model: "fake", messages: [] })) chunks.push(c);
// chunks: [{ type: "text_delta", text: "Hello" }, { type: "text_delta", text: ", world" }, { type: "message_done", ... }]
```

本仓库自身的一致性测试套件（conformance suite）也是通过这条缝对两个适配器离线运行的。

## 兼容性等级

仓库区分三个支持等级 —— “OpenAI 兼容”是协议层面的声明，不等于认证：

| 等级 | 含义 |
| --- | --- |
| **受维护适配器** | 仓库自有的映射与流翻译器；通过离线一致性测试（`anthropic()`、`openai()`）。 |
| **受维护预设** | 基于受维护适配器的仓库自有端点预设 —— [`@lite-agent/local`](/zh/packages/local) 中的 `localOpenAI` 预设。运行时与模型能力仍可能不同。 |
| **兼容端点** | 任何由用户提供、预期实现该协议的端点。在其确切的运行时/模型组合通过下面的探针之前，仅为尽力支持。 |

### 探测端点

一个可选的冒烟测试可按需验证真实的 OpenAI 兼容端点（默认 CI 中绝不运行）：

```bash
LITE_AGENT_COMPAT_BASE_URL=http://localhost:11434/v1 \
LITE_AGENT_COMPAT_MODEL=qwen3 \
pnpm --filter @lite-agent/provider test:compat
```

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `LITE_AGENT_COMPAT_BASE_URL` | 是 | 端点根地址。 |
| `LITE_AGENT_COMPAT_MODEL` | 是 | 模型 id。 |
| `LITE_AGENT_COMPAT_API_KEY` | 否 | 默认为 `local`。 |
| `LITE_AGENT_COMPAT_FORCED_TOOL` | 否 | 设为 `true` 时额外验证强制命名工具选择。 |

基础 profile 会检查：至少一个文本增量、恰好一个最终 `message_done`、增量拼接与最终文本一致、usage 字段形态。通过的含义是*该端点/运行时/模型组合已验证* —— 不代表该运行时上的每个模型行为一致。

## API 一览

| 符号 | 说明 |
| --- | --- |
| `anthropic(options?)` | 创建面向 Anthropic Messages API 的 `ModelProvider`。 |
| `openai(options?)` | 创建面向 OpenAI Chat Completions 或兼容端点的 `ModelProvider`。 |
| `AnthropicProviderOptions`、`OpenAIProviderOptions` | 工厂选项：`apiKey`、`baseURL`、`maxRetries`、`client`。 |
| `AnthropicClientLike`、`OpenAIClientLike` | `client` 选项接受的结构化 client 类型。 |

## 相关

- [`@lite-agent/core`](/zh/packages/core) —— provider 无关的 agent 内核（策略、中间件、事件流）。
- [`@lite-agent/sdk`](/zh/packages/sdk) —— 高层 `query` / `createLiteAgent` API。
- [`@lite-agent/local`](/zh/packages/local) —— 本地运行时（Ollama、vLLM、LM Studio、llama.cpp）的受维护预设。
