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

The package root re-exports both factories and their option types (`AnthropicProviderOptions`, `OpenAIProviderOptions`), plus the low-level `toAnthropicParams` / `toOpenAIParams` / `translateStream` mappers if you need them.

See the [monorepo root](../..) for architecture.
