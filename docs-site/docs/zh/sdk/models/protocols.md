# 支持的协议

本页说明模型接口、工具调用格式和 MCP 连接分别支持什么。选择厂商见[支持的厂商](/zh/sdk/models/providers)；无论使用哪种模型服务，SDK 创建入口都是 `createLiteAgent()`。

## 模型服务接口

以下能力基于 `@lite-agent/provider` 0.11.0，要求 Node.js >=22。使用 AI SDK 桥接时，厂商 adapter 必须实现 AI SDK 7 的 `LanguageModelV4`。

| 接口 / 协议族 | 接入方式 | 典型厂商 / 平台 | 流式传输 |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `openai()`、`localOpenAI()` 或 `aiSdk()` 配合 Chat adapter | OpenAI、DeepSeek、千问、智谱、Kimi，以及兼容服务 | HTTP + SSE |
| OpenAI Responses | `aiSdk(createOpenAI()(modelId))`；Azure 使用对应 adapter | OpenAI、Azure OpenAI | HTTP + SSE |
| xAI Responses | `aiSdk(createXai()(modelId))` | xAI Grok | HTTP + SSE |
| Anthropic Messages | `anthropic()` 或 `aiSdk()` 配合相应 adapter | Anthropic；MiniMax 使用 Messages 兼容接口 | HTTP + SSE |
| Gemini / Vertex Gemini | `aiSdk()` 配合 Google 或 Vertex adapter | Google Gemini、Google Vertex | HTTP + SSE |
| Amazon Bedrock Converse | `aiSdk()` 配合 Bedrock adapter | Amazon Bedrock 上支持 Converse 的模型 | HTTP + AWS 二进制事件流 |
| Cohere Chat v2 | `aiSdk()` 配合 Cohere adapter | Cohere | HTTP + SSE |

OpenAI 的 Chat Completions 和 Responses 是不同接口。当前 `openai()` 直接适配器调用 Chat Completions；需要 Responses 时选择 AI SDK 对应模型。相同协议族仍可能有鉴权、字段和模型能力差异，由厂商 adapter 处理。

Perplexity 经其专用 adapter 接入，当前覆盖文本场景；其他厂商及对应安装包见[厂商列表](/zh/sdk/models/providers)。兼容端点只表示它声明支持某种 API，不表示该服务的全部模型、工具能力或参数均已验证。

## 工具调用格式（codec）

codec 决定 agent 如何向模型描述工具、如何解析模型返回的调用，和上面的 HTTP API 是两个维度。

| 格式 | 配置 | 适用条件 |
| --- | --- | --- |
| 原生工具调用 | 默认 `nativeCodec()` | 模型及接口支持 function/tool calling；调用参数经 schema 校验，再通过权限和 Hook 执行 |
| JSON 提示词格式 | `codec: jsonCodec()` | 模型能按约定输出 JSON；工具定义放入提示词 |
| ReAct 提示词格式 | `codec: reactCodec()` | 模型能遵守 ReAct 输出格式；需要显式选择 |

更换 codec 不会自动补齐模型能力。提示词格式的可靠性需按模型验证，相关样例见 [Core 工具调用 codec](/zh/core/codecs)。

## MCP 外部工具协议

MCP 用于接入外部工具服务器，不是模型厂商 API。

| 项目 | 支持范围 |
| --- | --- |
| MCP 协议版本 | 固定 `2026-07-28`，不自动降级 |
| 传输 | stdio、Streamable HTTP |
| 认证 | HTTP headers；宿主配置的 OAuth 授权码 + PKCE、刷新令牌和机器凭证 |
| agent 入口 | 全局/项目 `mcps.json`、构造参数 `mcpServers`、`agent.mcp` |

旧 HTTP+SSE 传输和旧 MCP 协议不兼容。完整配置和安全边界见 [MCP 服务器](/zh/sdk/tools/mcp)。

## 能力与验证边界

当前 AI SDK 桥接支持文本、思考内容和函数工具的多轮往返；不提供图像/音频/视频生成入口，也不启用厂商代执行工具。`LanguageModelV4` 是适配器接口版本，不是 HTTP 协议。

协议测试、具体模型能力和远端账号可用性分别确认。遇到厂商明确报告不支持的设置时会失败，不静默忽略工具或思考参数。接入与原生选项见 [AI SDK 指南](/zh/core/ai-sdk)和[直接适配器配置](/zh/core/providers)。
