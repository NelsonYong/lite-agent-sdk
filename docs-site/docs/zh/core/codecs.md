# 工具调用 codec

`ToolCallCodec` 是连接工具语义与模型实际协议的策略：它把工具规格编码进发出的 `ModelRequest`，并把 assistant 的回复解码回 `{ text, calls }`。codec 让内核在两个方向上都做到 provider 无关——同一个内核既能驱动带原生 function calling 的前沿 API，也能驱动靠 prompt 工程的本地 7B 模型，切换协议只需改一行。

## 选择 codec

通过 `codec` 选项把 codec 传给 `createAgent`：

```ts
import { createAgent, nativeCodec, jsonCodec, reactCodec } from "@lite-agent/core";

const agent = createAgent({
  model: myLocalProvider,
  codec: jsonCodec(), // or nativeCodec() / reactCodec()
});
```

| Codec | 协议 | 流式 | 适用场景 |
| --- | --- | --- | --- |
| `nativeCodec()` | 工具规格作为原生 `tools` 传入；调用以结构化 block 返回 | passthrough | provider 有真正的 function calling（Anthropic、OpenAI）。默认选择。 |
| `jsonCodec(opts?)` | 整段响应的 JSON 协议注入 `system`：`{"type":"tool_calls","calls":[…]}` 或 `{"type":"final","text":…}` | buffer | 模型指令遵循能力强但没有原生工具 API（多数本地模型）。 |
| `reactCodec(opts?)` | ReAct 文本：`Action:` / `Action Input:` / `Observation:` / `Final Answer:`，每次响应至多一个工具 | buffer | 对文本推理轨迹的解析比严格 JSON 更稳的小模型。 |

:::tip
SDK 和严格单机装配会替你选 codec（provider 声明支持工具时用 `native`，否则用 JSON）。只有当你直接基于 `@lite-agent/core` 构建、或想要 ReAct 协议时才需要显式选择。
:::

## prompt codec 的工作原理

两种 prompt codec 共享同一套机制：

- **协议写进 system prompt。** `encode` 把协议说明（含工具目录）追加到 `system`，并把对话历史改写成 codec 的文本格式——assistant 的工具调用变成 `{"type":"tool_calls",…}` JSON 或 `Action:`/`Action Input:` 行，工具结果以 `tool_results` JSON 或 `Observation:` 行回灌。
- **缓冲式流式。** prompt codec 声明 `streaming: "buffer"`：内核缓冲模型输出直到能干净解码，协议文本不会以 `text_delta` 泄漏进你的事件流。
- **修复而不是失败。** 输出格式错误在解码时抛 `CodecError`；内核随后追加 codec 的 `repairPrompt`，让模型自己修复输出，最多重试 `maxDecodeRetries` 次（默认 2）再让运行失败。
- **确定性调用 id。** 模型不提供 id 时，工具调用 id 由响应内容推导，重试和回放保持稳定。

两个工厂都接受唯一选项 `instructions?: string`，在内置协议说明之后追加你自己的指引：

```ts
const codec = jsonCodec({
  instructions: "Prefer a single tool call per response; batch reads when possible.",
});
```

## 编写自定义 codec

你微调的本地模型说一种自定义的 `<<tool:...>>` 语法？实现 `ToolCallCodec` 接口插进来即可——工具、checkpoint、中间件原样可用：

```ts
import type { ToolCallCodec } from "@lite-agent/core";

const myCodec: ToolCallCodec = {
  streaming: "buffer", // prompt codecs buffer; native-style codecs omit this
  encode(req, tools) {
    // Return a ModelRequest with your protocol injected into system/history.
    return req;
  },
  decode(message) {
    // Normalize the assistant message into text + ToolCall[].
    // Throw CodecError on malformed output to trigger repairPrompt.
    return { text: "", calls: [] };
  },
  repairPrompt(error, attempt, tools) {
    // Optional: the user message appended after a decode failure.
    return { role: "user", content: `Format error: ${error.message}. Try again.` };
  },
};
```

## 另请参阅

- [九种策略](/zh/core/strategies)——`ToolCallCodec` 在内核策略接口中的位置。
- [模型提供方](/zh/core/providers)——配合 `nativeCodec()` 使用的 `anthropic()` / `openai()`。
- [严格单机装配](/zh/core/local)——本地运行时的 codec 自动选择（`"auto"`）。
- [测试工具](/zh/core/testing)——用 `fakeProvider` 端到端验证你的 codec。
