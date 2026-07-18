# Model providers

Model providers are the `ModelProvider` strategies that connect the kernel to a real model API. `@lite-agent/provider` ships two maintained adapters — `anthropic()` for the Anthropic Messages API and `openai()` for OpenAI Chat Completions — and because the whole Chat Completions family shares one wire format, the same adapter also drives OpenAI-compatible and local endpoints (Ollama, vLLM, LM Studio, llama.cpp). Both adapters translate the provider's SSE stream into normalized `ModelChunk`s and map every failure to `ProviderError`, so middleware like `retry()` works uniformly across vendors.

```bash
pnpm add @lite-agent/provider
```

## Quick start

Hand a provider to `query` from `@lite-agent/sdk` (or to `createAgent` from core):

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

Creates a `ModelProvider` (`id: "anthropic"`) that maps normalized requests to the [Anthropic Messages API](https://docs.claude.com/en/api/messages), wrapping `@anthropic-ai/sdk`.

### Options — `AnthropicProviderOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | `process.env.ANTHROPIC_API_KEY` | API key passed to the Anthropic SDK. |
| `baseURL` | `string` | `process.env.BASE_URL` | Endpoint override (proxies, gateways). |
| `maxRetries` | `number` | `0` | The Anthropic SDK's own retry count. See [Retries](#retries). |
| `client` | `AnthropicClientLike` | — | Inject a prebuilt or fake client instead of constructing one. See [Offline testing](#offline-testing-with-an-injected-client). |

The returned provider also advertises `context` capabilities: automatic prompt caching, `countTokens`, and — when the client's `beta.messages.create` surface is present — Anthropic-native context edits (`clearToolUses`, `clearThinking`, `compact`).

:::tip Custom headers
There is no `headers` option. To set default headers, timeouts, or other SDK settings, construct the Anthropic client yourself and pass it via `client`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@lite-agent/provider";

const client = new Anthropic({ defaultHeaders: { "x-trace-id": "..." } });
const claude = anthropic({ client });
```
:::

## `openai(options?)`

Creates a `ModelProvider` (`id: "openai"`) that maps normalized requests to [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat), wrapping the `openai` SDK. Because the whole protocol family shares one wire format, the same adapter works against OpenAI-compatible and local endpoints.

### Options — `OpenAIProviderOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | `process.env.OPENAI_API_KEY` | API key passed to the OpenAI SDK. Most local servers accept any non-empty string. |
| `baseURL` | `string` | `process.env.OPENAI_BASE_URL` | Endpoint override — this is how you point at OpenAI-compatible servers. |
| `maxRetries` | `number` | `0` | The OpenAI SDK's own retry count. See [Retries](#retries). |
| `client` | `OpenAIClientLike` | — | Inject a prebuilt or fake client. See [Offline testing](#offline-testing-with-an-injected-client). |

## OpenAI-compatible and local endpoints

`openai()` accepts any server that speaks Chat Completions. Point `baseURL` at the server's `/v1` root:

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

:::tip Maintained local presets
For loopback runtimes, prefer the [strict local assembly](/core/local): `localOpenAI` ships presets for `ollama`, `vllm`, `lm-studio`, and `llama.cpp`, enforces loopback-only endpoints, and runs a startup health probe.
:::

:::warning Capability varies by runtime and model
Chat Completions transport working does not mean every endpoint supports native tool calls or usage reporting for every model. See [Compatibility levels](#compatibility-levels) — verify a specific endpoint/runtime/model profile with the [opt-in probe](#probing-an-endpoint).
:::

## Stream translation: SSE → `ModelChunk`

Each adapter's core job is translating the provider's SSE event stream into the normalized `ModelChunk` union from `@lite-agent/core`:

```ts
type ModelChunk =
  | { type: "text_delta"; text: string }
  | { type: "message_done"; message: AssistantMessage; usage: Usage };
```

What the translators guarantee:

- Text deltas stream in source order; their concatenation equals the final text block.
- Tool calls are accumulated from provider-native argument fragments and emitted as normalized `{ type: "tool_call", id, name, input }` blocks with parsed JSON input.
- A successful stream ends with exactly one `message_done`, carrying the full `AssistantMessage` and `Usage` (`inputTokens` / `outputTokens`).

Adapter-specific behavior worth knowing:

- **Anthropic** also surfaces `cacheReadTokens` / `cacheCreationTokens` in `usage` when reported, emits `compaction` content blocks, and wraps unknown block types as `{ type: "native", provider: "anthropic", data }`. Malformed tool-call JSON throws.
- **OpenAI** assembles tool calls by `index` and falls back to `{}` when tool-call arguments fail to parse.

## Error handling

Both adapters catch SDK errors and rethrow them as `ProviderError` (from `@lite-agent/core`), preserving the numeric HTTP status when available:

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

This applies to failures before output and mid-stream failures alike, so the core `retry()` middleware can classify them uniformly.

## Retries

`maxRetries` defaults to `0` on both adapters on purpose: retry policy is owned by the core `retry()` middleware, and SDK-level retries would compound with it. Set `maxRetries` explicitly only if you want the SDK to retry on its own.

## Offline testing with an injected client

Both factories accept a `client` that only has to satisfy a small structural type — `AnthropicClientLike` (`messages.create` returning an async iterable of raw stream events) or `OpenAIClientLike` (`chat.completions.create` returning chunks). That makes tests fully deterministic and network-free:

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

The same seam is how the repo's own conformance suite runs against both adapters without any network access.

## Compatibility levels

The repo distinguishes three levels of support — "OpenAI-compatible" is a protocol claim, not a certification:

| Level | Meaning |
| --- | --- |
| **Maintained adapter** | Repository-owned mapping and stream translator; passes the offline conformance suite (`anthropic()`, `openai()`). |
| **Maintained preset** | Repository-owned endpoint preset built on a maintained adapter — the `localOpenAI` presets in the [strict local assembly](/core/local). Runtime and model capabilities still vary. |
| **Compatible endpoint** | Any user-supplied endpoint expected to speak the protocol. Best-effort until its exact runtime/model profile passes the probe below. |

### Probing an endpoint

An opt-in smoke test verifies a real OpenAI-compatible endpoint on demand (never in default CI):

```bash
LITE_AGENT_COMPAT_BASE_URL=http://localhost:11434/v1 \
LITE_AGENT_COMPAT_MODEL=qwen3 \
pnpm --filter @lite-agent/provider test:compat
```

| Variable | Required | Description |
| --- | --- | --- |
| `LITE_AGENT_COMPAT_BASE_URL` | yes | Endpoint root. |
| `LITE_AGENT_COMPAT_MODEL` | yes | Model id. |
| `LITE_AGENT_COMPAT_API_KEY` | no | Defaults to `local`. |
| `LITE_AGENT_COMPAT_FORCED_TOOL` | no | `true` additionally verifies forced named-tool selection. |

The base profile checks text deltas, a single final `message_done`, delta/final-text consistency, and usage shape. Passing means *verified for this endpoint/runtime/model profile* — not that every model on that runtime behaves identically.

## API summary

| Symbol | Description |
| --- | --- |
| `anthropic(options?)` | Create a `ModelProvider` for the Anthropic Messages API. |
| `openai(options?)` | Create a `ModelProvider` for OpenAI Chat Completions or compatible endpoints. |
| `AnthropicProviderOptions`, `OpenAIProviderOptions` | Factory options: `apiKey`, `baseURL`, `maxRetries`, `client`. |
| `AnthropicClientLike`, `OpenAIClientLike` | Structural client types accepted by the `client` option. |

## See also

- [The nine strategies](/core/strategies) — the `ModelProvider` strategy interface these adapters implement.
- [Tool-call codecs](/core/codecs) — pair `nativeCodec()` with these providers, or a prompt codec with local models.
- [Strict local assembly](/core/local) — maintained presets for local runtimes (Ollama, vLLM, LM Studio, llama.cpp).
- [Testing utilities](/core/testing) — `providerConformance` and `fakeProvider` for network-free tests.
