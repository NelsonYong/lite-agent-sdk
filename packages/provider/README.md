# @lite-agent/provider

**English** | [简体中文](./README.zh-CN.md)

Model providers for lite-agent. One package ships two `ModelProvider` strategies for [`@lite-agent/core`](../core):

- **`anthropic()`** — maps normalized requests to the [Anthropic Messages API](https://docs.claude.com/en/api/messages) (wrapping `@anthropic-ai/sdk`).
- **`openai()`** — maps them to [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat) (also works against OpenAI-compatible / local endpoints).

Each provider translates the provider SSE into `ModelChunk`s, wraps SDK errors in `ProviderError` (preserving `.status`), and exposes an injectable `client` seam for offline tests.

## Install

```bash
pnpm add @lite-agent/provider
```

## Usage

Hand a provider to `createLiteAgent` / `query` (from [`@lite-agent/sdk`](../sdk)) or to `createAgent` (from core):

```ts
import { anthropic, openai } from "@lite-agent/provider";

// Anthropic — reads ANTHROPIC_API_KEY and BASE_URL from env by default.
const claude = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.BASE_URL,
});

// OpenAI (or any OpenAI-compatible / local endpoint like Ollama, vLLM, LM Studio).
// Reads OPENAI_API_KEY and OPENAI_BASE_URL from env by default.
const gpt = openai({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "http://localhost:11434/v1", // e.g. a local server
});
```

```ts
import { query } from "@lite-agent/sdk";

for await (const ev of query({ prompt: "Hello!", model: claude, modelName: "claude-sonnet-4-6" })) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

## Options

Both `anthropic(opts)` and `openai(opts)` accept:

| Option | Description |
| --- | --- |
| `apiKey` | API key. Falls back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. |
| `baseURL` | Override the endpoint. Falls back to `BASE_URL` / `OPENAI_BASE_URL`. |
| `client` | Inject a custom/mock client (structural — used for offline tests). |
| `maxRetries` | The underlying SDK's own retry count. **Default `0`** so retry policy is owned by the core `retry()` middleware instead of compounding. |

The package root exports both factories and their option/client types
(`AnthropicProviderOptions`, `AnthropicClientLike`, `OpenAIProviderOptions`,
`OpenAIClientLike`). Request mappers and stream translators are internal adapter
details and are not public package-root exports.

## Support levels

| Level | Meaning |
| --- | --- |
| Maintained adapter | Repository-owned request mapping and stream translation; passes the offline shared conformance suite. |
| Maintained preset | Repository-owned endpoint/configuration preset using a maintained adapter; runtime and model capabilities still vary. |
| Compatible endpoint | User-supplied endpoint expected to speak the protocol; best-effort until that exact runtime/model profile is probed. |

| Integration | Level | Notes |
| --- | --- | --- |
| Anthropic Messages | Maintained adapter | Text streaming, tool calls, normalized usage, abort propagation, and `ProviderError` normalization are covered offline. |
| OpenAI Chat Completions | Maintained adapter | The same shared offline contract is applied. |
| Ollama, vLLM, LM Studio, llama.cpp | Maintained preset in [`@lite-agent/local`](../local) | Uses the OpenAI-compatible adapter; native tool and usage support depend on the selected runtime and model. |
| Other OpenAI-compatible endpoints | Compatible endpoint | Not verified by default; run the profile below against the exact endpoint and model. |

"Compatible" is not a blanket certification. Servers differ in streaming,
`stream_options`, tool-choice, usage, and error behavior.

## Probe an OpenAI-compatible endpoint

The probe is deliberately excluded from normal tests and runs only through its
dedicated command:

```bash
LITE_AGENT_COMPAT_BASE_URL=http://127.0.0.1:11434/v1 \
LITE_AGENT_COMPAT_MODEL=qwen3:8b \
pnpm --filter @lite-agent/provider test:compat
```

`LITE_AGENT_COMPAT_API_KEY` is optional and defaults to `local`.
`LITE_AGENT_COMPAT_FORCED_TOOL` accepts `true` or `false` (default `false`);
other non-empty values are rejected before client construction. Set it to
`true` to add a stronger profile that forces the named `echo` tool. Passing
that profile proves named forced-tool selection; it does not claim that every
native tool-choice mode is supported.

The adapters currently differ on malformed streamed tool JSON: Anthropic
surfaces a provider error, while OpenAI falls back to an empty input object and
lets downstream tool-schema validation reject it.

See the [monorepo root](../..) for architecture.
