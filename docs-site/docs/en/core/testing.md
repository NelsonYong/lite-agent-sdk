# Testing utilities

The kernel is testable without any network access. `@lite-agent/core` ships a scripted `ModelProvider` test double (`fakeProvider`) so agent-loop tests are deterministic, plus two conformance suites — `providerConformance` and `checkpointerConformance` — that validate any custom strategy implementation against the exact contract the kernel relies on. If you write your own provider or persistence backend, running these suites is the cheapest way to know you got the contract right.

## Scripting a model with `fakeProvider`

`fakeProvider(turns)` replays scripted `FakeTurn`s (`{ text?, message, usage? }`) in order — deterministic, no network. Use it to drive the full kernel loop in a unit test:

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]),
  codec: nativeCodec(),
});

const result = await agent.send("hello");
console.log(result.text); // "hi"
```

Each scripted turn can carry text, a complete assistant message (including `tool_call` blocks, to exercise the tool phase), and a `usage` record. Because `fakeProvider` is a real `ModelProvider`, everything around it — middleware, codecs, checkpointers, permission gates — runs exactly as in production.

## `providerConformance`

An array of named test cases that any `ModelProvider` must pass: text-delta ordering, a single terminal `message_done`, error mapping to `ProviderError`, and abort handling. Feed it a `ProviderConformanceFactory` that builds your provider for each `ProviderConformanceScenario`:

```ts
import { providerConformance } from "@lite-agent/core";

for (const test of providerConformance) {
  it(test.name, () => test.run((scenario) => makeMyProvider(scenario)));
}
```

The maintained `anthropic()` and `openai()` adapters pass this suite offline, via their injected-client seam.

## `checkpointerConformance`

The same idea for `Checkpointer` backends: monotonic seq, `sinceSeq` replay, conflict rejection (`CheckpointConflictError` on a stale `expectedHead`), list/delete, serialized concurrent appends, and payload round-trip:

```ts
import { checkpointerConformance } from "@lite-agent/core";

for (const test of checkpointerConformance) {
  it(test.name, () => test.run(() => myCheckpointer()));
}
```

The [SQLite backend](/core/persistence) validates itself against this suite — the same one the SDK's default `fileCheckpointer` runs against. Run it against your own backend before trusting it with real sessions.

## See also

- [Model providers](/core/providers) — offline testing with an injected client, and the endpoint probe for real servers.
- [Session persistence](/core/persistence) — the `Checkpointer` contract the conformance suite validates.
- [Tool-call codecs](/core/codecs) — exercise custom codecs end to end with `fakeProvider`.
- [The nine strategies](/core/strategies) — the strategy contracts behind both suites.
