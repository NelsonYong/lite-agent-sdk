# Mainstream providers through AI SDK

Since `@lite-agent/provider` 0.11.0, `aiSdk(model, options?)` bridges AI SDK 7 **LanguageModelV4** models. It requires **Node.js >=22** and rejects legacy V2/V3 contracts.

The bridge normalizes requests and streams; maintained vendor adapters own HTTP, authentication and wire formats. Vendor packages below are installed by the host as needed, not bundled as production dependencies. There is no second agent loop, implicit Gateway, extra retry layer or automatic input-URL download.

## Quick start

```bash
pnpm add @lite-agent/sdk @lite-agent/provider @ai-sdk/google
```

```ts
import { createLiteAgent } from '@lite-agent/sdk';
import { aiSdk } from '@lite-agent/provider';
import { createGoogle } from '@ai-sdk/google';

const google = createGoogle({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
const model = google(process.env.GEMINI_MODEL!);
const agent = createLiteAgent({
  workdir: process.cwd(),
  model: aiSdk(model, { context: { contextWindow: 128_000 } }),
});
try {
  console.log((await agent.send('Analyze this project')).text);
} finally {
  await agent.close();
}
```

Set the window to the actual model limit; it is not inferred from model names. The bridge provider id is its bound `modelId`, so ordinary calls can omit `modelName`. Explicit names must match. For multi-agent `models` profiles, bind a matching provider instance for each model instead of silently ignoring routing choices.

## Coverage

The SDK [supported providers](/sdk/models/providers) page owns the vendor matrix, packages, factories, compatible endpoints and verification scope. See [supported protocols](/sdk/models/protocols) for protocol distinctions. This page covers bridge configuration and replay behavior.

## Behavior

- Maps token limits, temperature, topP, stop sequences, seed, function schemas and tool choice to standard V4 parameters.
- Maps `reasoningEffort` to V4 `reasoning`; vendor adapters handle their fields. Main and child agents can use different efforts. Dedicated tests cover high effort for OpenAI, Anthropic and Gemini.
- Streams visible text. Reasoning is retained as model-scoped native state, not exposed as visible text deltas.
- Preserves tool ids, names, full arguments and error results. lite-agent still owns tool execution, permissions, hooks and concurrency.
- Round-trips thinking signatures, OpenAI encrypted reasoning and assistant phase through JSON checkpoints. Native state cannot be replayed into a different provider/model.
- Retains source citations as native host data without fetching their URLs. This bridge supports text, reasoning and function tools. Media/file output and provider-executed tools fail explicitly rather than being discarded or bypassing local permissions.
- Aborts requests and cancels readers on cancellation/early iterator return. HTTP failures retain `ProviderError.status`. Retry remains an explicit lite-agent middleware choice.
- Fails on vendor `unsupported` warnings instead of ignoring requested features. Observe other warnings through `onWarning`.

## Provider options and storage

```ts
const provider = aiSdk(openaiModel, {
  providerOptions: { openai: { store: false } },
  onWarning: warning => console.warn(warning.type),
});
```

`providerOptions` may also be a function of the current `ModelRequest`. The bridge does not override a vendor's server-side storage/privacy defaults; explicitly configure OpenAI Responses `store: false` when appropriate. This is not redaction or an offline guarantee.

Supply `context` only for capabilities you actually know, such as a context window or true request-token counter. The bridge does not guess native compaction, exact counting or prompt-cache support. The direct `anthropic()` adapter remains available for its specialized native context management.

## Validation and references

Offline tests execute installed vendor SDKs against HTTP/SSE/Bedrock binary-event fixtures, covering text/tool replay, metadata, usage, failures and no automatic retry. Providers without credentials are not claimed as live-tested. Live scripts and artifacts remain outside the repository.

- [AI SDK providers](https://ai-sdk.dev/providers/ai-sdk-providers)
- [AI SDK source and contracts](https://github.com/vercel/ai)
- [OpenAI reasoning and phase](https://developers.openai.com/api/docs/guides/reasoning#phase-parameter)
- [Direct adapters and endpoint probes](/core/providers)
