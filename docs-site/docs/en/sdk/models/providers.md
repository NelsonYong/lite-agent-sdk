# Supported providers

Direct adapters and the AI SDK 7 bridge feed the same `createLiteAgent()` entry point. The current provider package requires Node.js >=22.

## Choose an integration path

| Scenario | Recommended entry |
| --- | --- |
| OpenAI Chat Completions / Anthropic Messages | `openai()` / `anthropic()` from `@lite-agent/provider` |
| Local Ollama, vLLM, LM Studio or llama.cpp | `localOpenAI()` from the same package; the service must expose Chat Completions compatibility |
| OpenAI Responses, Gemini, cloud platforms and other vendors | `aiSdk(vendorModel)`, with an adapter installed as needed |
| A vendor or private gateway exposes Chat Completions compatibility | `openai({ baseURL })` or AI SDK `createOpenAICompatible()` |

Check the [protocol matrix](/sdk/models/protocols), then select an adapter below. See [AI SDK integration](/core/ai-sdk) and [direct adapter configuration](/core/providers) for complete examples, authentication and parameters.

## Providers and adapters

These paths have offline HTTP protocol tests using the actual vendor SDKs. This is not account-level or all-model certification. Coverage comprises 21 vendors/platforms, both OpenAI protocols and one generic compatible path.

| Vendor/platform | Install as needed | Model factory | Tested protocol |
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
| MiniMax | `@ai-sdk/minimax` | `createMiniMax()(modelId)` | Anthropic-compatible |
| xAI Grok | `@ai-sdk/xai` | `createXai()(modelId)` | Responses |
| Mistral | `@ai-sdk/mistral` | `createMistral()(modelId)` | Chat |
| Groq | `@ai-sdk/groq` | `createGroq()(modelId)` | Chat |
| Cohere | `@ai-sdk/cohere` | `createCohere()(modelId)` | Cohere v2 |
| Together AI | `@ai-sdk/togetherai` | `createTogetherAI()(modelId)` | Chat |
| Fireworks | `@ai-sdk/fireworks` | `createFireworks()(modelId)` | Chat |
| Cerebras | `@ai-sdk/cerebras` | `createCerebras()(modelId)` | Chat |
| DeepInfra | `@ai-sdk/deepinfra` | `createDeepInfra()(modelId)` | Chat |
| Perplexity | `@ai-sdk/perplexity` | `createPerplexity()(modelId)` | Chat (text-only verification) |
| OpenRouter | `@openrouter/ai-sdk-provider` | `createOpenRouter()(modelId)` | Chat (community adapter) |

Configure keys, endpoints, regions, projects, credential chains and custom fetch in the vendor's `createXxx(settings)` factory. Azure uses deployment ids. Bedrock and Vertex retain their official authentication mechanisms.

Perplexity is covered as a text provider; configure `allowedTools: []`, not native tool calls. Other rows validate a protocol path, not every available model's tool capability. OpenRouter is a community adapter maintained by its team.

## Compatible endpoints: Doubao, Baidu, Tencent, SiliconFlow and private endpoints

For an endpoint explicitly documented as OpenAI Chat compatible, use the maintained compatibility adapter:

```ts
import { aiSdk } from '@lite-agent/provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const compatible = createOpenAICompatible({
  name: 'my-endpoint',
  baseURL: process.env.MODEL_BASE_URL!, // Vendor-documented URL for your region/product
  apiKey: process.env.MODEL_API_KEY,
});
const provider = aiSdk(compatible(process.env.MODEL_ID!));
```

This validates the common protocol bridge, not each remote deployment or account. Image/video-only provider packages are not language models. Community adapters must expose V4. Existing `openai()`, `anthropic()` and `localOpenAI()` remain available.

## Validation and capability limits

| Status | Meaning |
| --- | --- |
| Offline wire verification | Actual vendor SDKs run against response fixtures for tool replay, streaming, usage, errors and no automatic retry; Perplexity is text-only |
| Generic compatibility verification | The compatible adapter is tested; individual Doubao, Baidu, Tencent, SiliconFlow or private deployments still need endpoint/model validation |
| Live model verification | `ugreen-ai-model` completed two model requests and one file-tool call through the bridge; this does not certify every vendor's live service |

Vendor support does not imply identical capabilities across all its models. Verify tool calling, reasoning effort, context window, region and account access for your model. Configure `allowedTools: []` for Perplexity. The bridge currently handles text, reasoning and function tools, not image/audio/video generation or provider-executed tools.

Community adapters must implement current `LanguageModelV4`; V2/V3 are unsupported. Additional compatible vendors do not require a new agent type.
