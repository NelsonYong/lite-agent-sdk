# Supported protocols

This page distinguishes model APIs, tool-call formats and MCP connections. See [supported providers](/sdk/models/providers) to choose a vendor. Every integration uses the same SDK constructor, `createLiteAgent()`.

## Model service APIs

These paths are available through `@lite-agent/provider` 0.11.0 and require Node.js >=22. AI SDK adapters must expose the AI SDK 7 `LanguageModelV4` contract.

| API / protocol family | Integration | Typical vendors / platforms | Streaming transport |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `openai()`, `localOpenAI()`, or `aiSdk()` with a Chat adapter | OpenAI, DeepSeek, Qwen, GLM, Kimi and compatible endpoints | HTTP + SSE |
| OpenAI Responses | `aiSdk(createOpenAI()(modelId))`; Azure uses its adapter | OpenAI, Azure OpenAI | HTTP + SSE |
| xAI Responses | `aiSdk(createXai()(modelId))` | xAI Grok | HTTP + SSE |
| Anthropic Messages | `anthropic()` or `aiSdk()` with the corresponding adapter | Anthropic; MiniMax uses Messages compatibility | HTTP + SSE |
| Gemini / Vertex Gemini | `aiSdk()` with Google or Vertex adapters | Google Gemini, Google Vertex | HTTP + SSE |
| Amazon Bedrock Converse | `aiSdk()` with the Bedrock adapter | Bedrock models supporting Converse | HTTP + AWS binary event stream |
| Cohere Chat v2 | `aiSdk()` with the Cohere adapter | Cohere | HTTP + SSE |

Chat Completions and Responses are distinct APIs. The direct `openai()` adapter calls Chat Completions; choose an AI SDK Responses model for Responses. Authentication, fields and model capabilities can differ even within a protocol family; vendor adapters handle those differences.

Perplexity uses its dedicated adapter and is currently covered for text. See the [provider matrix](/sdk/models/providers) for other vendors and packages. Protocol compatibility is not certification of every model, tool capability or parameter on a service.

## Tool-call formats (codecs)

A codec describes tools to the model and decodes generated calls. This is independent of the HTTP API above.

| Format | Configuration | Requirements |
| --- | --- | --- |
| Native tool calling | Default `nativeCodec()` | Model/API supports function calling; arguments are schema-validated before permission and hook processing |
| JSON prompt format | `codec: jsonCodec()` | Model follows the JSON convention; tool definitions are embedded in the prompt |
| ReAct prompt format | `codec: reactCodec()` | Model follows the ReAct format; selection is explicit |

Changing codecs does not automatically add model capabilities. Validate prompt-format reliability with the selected model. See [Core tool-call codecs](/core/codecs).

## MCP external tools

MCP connects external tool servers; it is not a model-vendor API.

| Item | Support |
| --- | --- |
| Protocol version | Pinned `2026-07-28`, without automatic fallback |
| Transports | stdio, Streamable HTTP |
| Authentication | HTTP headers; host-configured OAuth code + PKCE, refresh and machine credentials |
| Agent integration | Global/project `mcps.json`, constructor `mcpServers`, `agent.mcp` |

Legacy HTTP+SSE transport and older MCP revisions are unsupported. See [MCP servers](/sdk/tools/mcp) for configuration and security boundaries.

## Capability and verification boundaries

The AI SDK bridge supports multi-turn text, reasoning and function tools. It does not expose image/audio/video generation or enable provider-executed tools. `LanguageModelV4` is an adapter interface version, not an HTTP protocol.

Protocol tests, individual model capabilities and remote account access are separate checks. Explicit vendor reports of unsupported settings fail rather than silently ignoring tool or reasoning controls. See [AI SDK integration](/core/ai-sdk) and [direct adapter settings](/core/providers).
