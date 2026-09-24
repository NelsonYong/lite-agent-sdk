# 支持的厂商

当前 provider 包通过直接适配器和 AI SDK 7 桥接接入模型，所有模型最终交给同一个 `createLiteAgent()`。要求 Node.js >=22。

## 如何选择接入方式

| 场景 | 推荐入口 |
| --- | --- |
| OpenAI Chat Completions / Anthropic Messages | `@lite-agent/provider` 的 `openai()` / `anthropic()` |
| 本地 Ollama、vLLM、LM Studio、llama.cpp | 同一包的 `localOpenAI()`；模型服务需提供 Chat Completions 兼容接口 |
| OpenAI Responses、Gemini、云平台及其他厂商 | `aiSdk(厂商模型实例)`，按需安装下面的 adapter |
| 厂商或私有网关提供 Chat Completions 兼容端点 | `openai({ baseURL })` 或 AI SDK 的 `createOpenAICompatible()` |

先看[协议支持表](/zh/sdk/models/protocols)确认接口，再按下表选择厂商包。完整代码、鉴权配置和参数映射见 [AI SDK 接入指南](/zh/core/ai-sdk)及[直接适配器配置](/zh/core/providers)。

## 厂商与接入包

以下使用实际 provider SDK 做离线 HTTP 协议验证，不代表持有各家账号或完成所有模型的真机认证。共覆盖 21 个厂商/平台、OpenAI 的两种协议和一个通用兼容入口。模型的工具能力与部署权限仍由厂商决定。

| 厂商/平台 | 按需安装 | 创建模型 | 已验证协议 |
| --- | --- | --- | --- |
| OpenAI | `@ai-sdk/openai` | `createOpenAI()(modelId)` | Responses / Chat |
| Anthropic | `@ai-sdk/anthropic` | `createAnthropic()(modelId)` | Messages |
| Google Gemini | `@ai-sdk/google` | `createGoogle()(modelId)` | Gemini |
| Azure OpenAI | `@ai-sdk/azure` | `createAzure(settings)(deploymentId)` | Responses |
| Amazon Bedrock | `@ai-sdk/amazon-bedrock` | `createAmazonBedrock(settings)(modelId)` | Converse |
| Google Vertex | `@ai-sdk/google-vertex` | `createGoogleVertex(settings)(modelId)` | Vertex Gemini |
| DeepSeek | `@ai-sdk/deepseek` | `createDeepSeek()(modelId)` | Chat |
| Alibaba Qwen / 千问 | `@ai-sdk/alibaba` | `createAlibaba()(modelId)` | Chat |
| Z.AI GLM / 智谱 | `@ai-sdk/zai` | `createZai()(modelId)` | Chat |
| Moonshot Kimi | `@ai-sdk/moonshotai` | `createMoonshotAI()(modelId)` | Chat |
| MiniMax | `@ai-sdk/minimax` | `createMiniMax()(modelId)` | Messages 兼容 |
| xAI Grok | `@ai-sdk/xai` | `createXai()(modelId)` | Responses |
| Mistral | `@ai-sdk/mistral` | `createMistral()(modelId)` | Chat |
| Groq | `@ai-sdk/groq` | `createGroq()(modelId)` | Chat |
| Cohere | `@ai-sdk/cohere` | `createCohere()(modelId)` | Cohere v2 |
| Together AI | `@ai-sdk/togetherai` | `createTogetherAI()(modelId)` | Chat |
| Fireworks | `@ai-sdk/fireworks` | `createFireworks()(modelId)` | Chat |
| Cerebras | `@ai-sdk/cerebras` | `createCerebras()(modelId)` | Chat |
| DeepInfra | `@ai-sdk/deepinfra` | `createDeepInfra()(modelId)` | Chat |
| Perplexity | `@ai-sdk/perplexity` | `createPerplexity()(modelId)` | Chat（仅文本验证） |
| OpenRouter | `@openrouter/ai-sdk-provider` | `createOpenRouter()(modelId)` | Chat（社区适配器） |

各 SDK 提供自己的 `apiKey`、端点、区域、项目、凭证链及 `fetch` 等设置；这些设置放在厂商的 `createXxx(settings)` 中。Azure 使用 deployment id，Bedrock/Vertex 使用对应云端凭证或其官方支持的认证方式。

Perplexity 当前按文本模型接入：使用 `allowedTools: []`；不能承诺原生工具调用。其他行验证的是具体协议路径，仍应选择支持工具的模型。OpenRouter 属于其官方团队维护的社区 adapter。

## 兼容端点：豆包、百度、腾讯、硅基流动及自建兼容服务

对于厂商明确提供的 OpenAI Chat 兼容端点，复用官方 `@ai-sdk/openai-compatible`：

```ts
import { aiSdk } from '@lite-agent/provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const compatible = createOpenAICompatible({
  name: 'my-endpoint',
  baseURL: process.env.MODEL_BASE_URL!, // 使用厂商文档中与你的地域/产品对应的 URL
  apiKey: process.env.MODEL_API_KEY,
});
const provider = aiSdk(compatible(process.env.MODEL_ID!));
```

这条路径验证了兼容协议桥接，没有逐一验证这些服务的远端账号和模型。不要把仅支持图像/视频的厂商包当作语言模型 provider；社区包也必须实现 V4。现有 `openai()` / `anthropic()` / `localOpenAI()` 可继续使用。

## 验证范围与能力限制

| 状态 | 当前含义 |
| --- | --- |
| 离线协议验证 | 使用真实厂商 SDK 配合响应样本；覆盖表中的工具多轮、流式结果、usage、错误状态与不自动重试，Perplexity 仅验证文本 |
| 通用兼容协议验证 | 兼容 adapter 已通过测试；豆包、百度、腾讯、硅基流动等具体部署仍需自己的 endpoint/model 验证 |
| 真实模型验证 | `ugreen-ai-model` 已通过桥接完成两次模型请求和一次文件工具调用，不外推为所有厂商真机通过 |

接入厂商不等于该厂商所有模型具备相同能力。工具调用、思考强度、上下文窗口、地域和账号权限需按模型确认；Perplexity 使用 `allowedTools: []`。统一桥接目前处理文本、思考与函数工具，不包含图像/音频/视频生成或厂商代执行工具。

社区 adapter 需实现当前 `LanguageModelV4`。V2/V3 不受支持；新增兼容厂商无需新增一种 agent 类型。
