# @lite-agent/provider

**English** | [简体中文](./README.zh-CN.md)

Model providers for lite-agent: ready-to-use `ModelProvider` strategies that connect [`@lite-agent/core`](../core) to the Anthropic Messages API and to OpenAI Chat Completions (including OpenAI-compatible and local endpoints).

## Install

```bash
pnpm add @lite-agent/provider
```

## Quick start

Hand a provider to `query` from [`@lite-agent/sdk`](../sdk) (or to `createAgent` from core):

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

## Features

- **`anthropic()`** — maps normalized requests to the [Anthropic Messages API](https://docs.claude.com/en/api/messages), wrapping `@anthropic-ai/sdk`.
- **`openai()`** — maps them to [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat); also works against OpenAI-compatible / local endpoints.
- Translates provider SSE streams into normalized `ModelChunk`s (text deltas, tool calls, usage).
- Wraps SDK errors in `ProviderError`, preserving the HTTP `.status`.
- Injectable `client` seam (structural typing) for offline tests with mock clients.
- `maxRetries` defaults to `0`, so retry policy is owned by the core `retry()` middleware instead of compounding.
- Passes the repo's offline shared conformance suite; an opt-in probe (`pnpm --filter @lite-agent/provider test:compat`) verifies other OpenAI-compatible endpoints on demand.

## API

| Symbol | Description |
| --- | --- |
| `anthropic(options?)` | Create a `ModelProvider` for the Anthropic Messages API. |
| `openai(options?)` | Create a `ModelProvider` for OpenAI Chat Completions or compatible endpoints. |
| `AnthropicProviderOptions`, `OpenAIProviderOptions` | Factory options: `apiKey` and `baseURL` (env fallback), `client`, `maxRetries`. |
| `AnthropicClientLike`, `OpenAIClientLike` | Structural client types accepted by the `client` option. |

## Related

- [`@lite-agent/core`](../core) — provider-agnostic agent kernel (strategies, middleware, event stream).
- [`@lite-agent/sdk`](../sdk) — high-level `query` / `createLiteAgent` API.
- [`@lite-agent/local`](../local) — maintained presets for local runtimes (Ollama, vLLM, LM Studio, llama.cpp).
- [Monorepo root](../..) — architecture overview.
