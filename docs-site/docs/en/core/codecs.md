# Tool-call codecs

A `ToolCallCodec` is the strategy that bridges tool semantics and whatever protocol your model actually speaks: it encodes tool specs into the outgoing `ModelRequest` and decodes the assistant's reply back into `{ text, calls }`. The codec is what makes the kernel provider-agnostic in both directions — the same kernel drives a frontier API with native function calling or a local 7B model with prompt engineering, and swapping protocols is a one-line change.

## Choosing a codec

Pass a codec to `createAgent` via the `codec` option:

```ts
import { createAgent, nativeCodec, jsonCodec, reactCodec } from "@lite-agent/core";

const agent = createAgent({
  model: myLocalProvider,
  codec: jsonCodec(), // or nativeCodec() / reactCodec()
});
```

| Codec | Protocol | Streaming | Use it when |
| --- | --- | --- | --- |
| `nativeCodec()` | Tool specs passed as native `tools`; calls arrive as structured blocks | passthrough | The provider has real function calling (Anthropic, OpenAI). The default choice. |
| `jsonCodec(opts?)` | Whole-response JSON protocol injected into `system`: `{"type":"tool_calls","calls":[…]}` or `{"type":"final","text":…}` | buffer | The model follows instructions well but has no native tool API (most local models). |
| `reactCodec(opts?)` | ReAct text: `Action:` / `Action Input:` / `Observation:` / `Final Answer:`, one tool per response | buffer | Small models that parse better with a textual reasoning trace than strict JSON. |

:::tip
The SDK and the strict local assembly pick a codec for you (`native` when the provider declares tool support, otherwise JSON). Choose explicitly only when you build on `@lite-agent/core` directly or want the ReAct protocol.
:::

## How the prompt codecs work

Both prompt codecs share the same mechanics:

- **Protocol in the system prompt.** `encode` appends protocol instructions (including the tool catalog) to `system` and rewrites conversation history into the codec's textual format — assistant tool calls become `{"type":"tool_calls",…}` JSON or `Action:`/`Action Input:` lines, and tool results come back as `tool_results` JSON or `Observation:` lines.
- **Buffered streaming.** Prompt codecs declare `streaming: "buffer"`: the kernel holds model output until it decodes cleanly, so protocol text never leaks into your event stream as `text_delta`.
- **Repair instead of failure.** Malformed output throws `CodecError` on decode; the kernel then appends the codec's `repairPrompt` and asks the model to fix its own output, retrying up to `maxDecodeRetries` times (default 2) before failing the run.
- **Deterministic call ids.** When the model doesn't supply one, tool-call ids are derived from the response content, so retries and replays stay stable.

Both factories accept a single option, `instructions?: string`, to append your own protocol guidance after the built-in instructions:

```ts
const codec = jsonCodec({
  instructions: "Prefer a single tool call per response; batch reads when possible.",
});
```

## Writing a custom codec

Your fine-tuned local model speaks a bespoke `<<tool:...>>` syntax? Implement the `ToolCallCodec` interface and plug it in — tools, checkpoints, and middleware work unchanged:

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

## See also

- [The nine strategies](/core/strategies) — where `ToolCallCodec` sits among the kernel's strategy interfaces.
- [Model providers](/core/providers) — `anthropic()` / `openai()` for use with `nativeCodec()`.
- [Strict local assembly](/core/local) — automatic codec selection (`"auto"`) for local runtimes.
- [Testing utilities](/core/testing) — exercise your codec end to end with `fakeProvider`.
