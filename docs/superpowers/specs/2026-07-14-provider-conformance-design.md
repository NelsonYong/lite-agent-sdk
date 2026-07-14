# Provider Conformance and Compatibility — Design

**Status:** Direction approved in chat; written spec pending review
**Date:** 2026-07-14

## 1. Decision

Do not add another first-party model provider yet. Keep Anthropic Messages and
OpenAI Chat Completions as the two maintained protocol families, and make their
support boundary measurable before expanding the provider count.

This slice adds:

1. a reusable, provider-neutral conformance suite for `ModelProvider` adapters;
2. an opt-in smoke test for OpenAI-compatible endpoints;
3. an honest compatibility matrix with explicit support levels; and
4. corrections to provider documentation that currently overstates the public
   low-level export surface.

The next native provider remains a demand-triggered follow-up. If that trigger
is met, the default candidate is Google Gemini in a separate package rather than
another mandatory SDK dependency in `@lite-agent/provider`.

## 2. Motivation

The repository has two first-party factories, but they cover more than two
model brands:

- `anthropic()` implements Anthropic Messages.
- `openai()` implements OpenAI Chat Completions and accepts a custom `baseURL`.
- `localOpenAI()` already supplies presets for Ollama, vLLM, LM Studio, and
  llama.cpp through the OpenAI-compatible path.

The current gap is therefore not raw provider count. It is the absence of a
shared contract proving that an adapter preserves the normalized streaming,
tool-call, usage, abort, and error semantics on which the kernel depends.
OpenAI compatibility is also currently a broad protocol claim without a
repeatable endpoint probe or a documented distinction between maintained,
preset, and unverified integrations.

The core abstraction is already sufficient:

```ts
interface ModelProvider {
  readonly id: string;
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelChunk>;
}
```

No kernel, codec, or middleware change is needed.

## 3. Goals and success criteria

### Goals

- Define the minimum observable behavior every `ModelProvider` must satisfy.
- Run the same offline cases against both first-party adapters through their
  injected client seams.
- Give future adapter authors a small reusable test utility, following the
  existing `checkpointerConformance` precedent.
- Provide an opt-in real-endpoint probe without making normal CI depend on
  network access, credentials, model availability, or local runtimes.
- Describe compatibility without implying that every OpenAI-compatible server
  has been certified.

### Success criteria

- Anthropic and OpenAI pass the same conformance cases without network access.
- Existing provider-specific mapping and stream tests remain in place and pass.
- A maintainer can probe a configured OpenAI-compatible endpoint with one pnpm
  command and explicit environment variables.
- Default build, test, and typecheck commands never access the network.
- Documentation distinguishes maintained adapters, maintained presets, and
  unverified compatible endpoints.
- No new runtime dependency, provider SDK, provider factory, or normalized
  model capability is introduced.

### Implementation discipline

The implementation must remain deliberately small and follow the patterns the
repository already uses:

- **Strategy** remains the existing `ModelProvider`; do not add another provider
  interface, base class, registry, capability resolver, or plugin framework.
- **Adapter** remains each provider's current mapping + stream translator; do
  not refactor production adapters merely to share test code.
- **Contract Test** mirrors the flat `checkpointerConformance` case-array style;
  do not introduce a test DSL, class hierarchy, builder, or generic fixture
  engine.
- **Dependency Injection** uses the existing `client` option for deterministic
  provider tests; do not add a second injection mechanism.
- Prefer a few explicit provider-specific fixture helpers over an abstraction
  whose only purpose is removing small amounts of test duplication.
- Every new type and file must be required by a current acceptance criterion.
  Future Gemini or community adapters must not drive speculative API surface.

Good design here means clear boundaries and observable contracts, not more
layers. If the implementation needs materially more machinery than the file
impact in section 10, stop and revisit the design before adding it.

## 4. Approaches considered

### A. Add Gemini immediately

This improves first-party breadth and tests the abstraction against a third
protocol. It also adds another SDK, authentication model, mapping layer, stream
state machine, documentation surface, and long-term upgrade obligation before
there is repository evidence of a concrete user need. Rejected for this slice.

### B. Add vendor presets only

Small wrappers around `openai({ baseURL })` improve discoverability for services
that implement Chat Completions. They do not prove streaming, tool calls, usage,
or error behavior, and they risk turning an unverified assumption into an API
promise. Deferred until a corresponding endpoint profile has been exercised.

### C. Conformance first, then demand-triggered native providers

This is the selected approach. It strengthens the existing two protocol
families, makes compatible endpoints testable, and creates the acceptance bar
for a future Gemini, Bedrock, Vertex, Azure, or community adapter.

## 5. Conformance contract

Add `packages/core/src/testing/providerConformance.ts` and export it from the
core package root next to `checkpointerConformance`.

The module uses `node:assert/strict`, not Vitest, so external provider packages
can execute the cases with any test runner. Its public shape is:

```ts
export type ProviderConformanceScenario =
  | {
      kind: "text";
      deltas: string[];
      usage: Usage;
    }
  | {
      kind: "tool";
      textDeltas: string[];
      call: ToolCall;
      usage: Usage;
    }
  | {
      kind: "error";
      error: unknown;
      afterText?: string;
    }
  | { kind: "abort" };

export type ProviderConformanceFactory = (
  scenario: ProviderConformanceScenario,
) => ModelProvider;

export const providerConformance: Array<{
  name: string;
  run(make: ProviderConformanceFactory): Promise<void>;
}>;
```

Each provider-specific test driver converts a semantic scenario into that
vendor SDK's fake raw events and returns the real provider factory wired to an
injected fake client. The driver is test code; the production adapter remains
unaware of conformance fixtures.

The required cases are:

1. **Identity and finalization** — `id` is non-empty; a successful stream emits
   exactly one `message_done`, and it is the last chunk.
2. **Text ordering** — text deltas are yielded in source order and their
   concatenation equals the final text block.
3. **Tool normalization** — the final message contains one normalized tool call
   with the exact id, name, and parsed input; preceding text remains ordered
   before the tool block. Provider-native argument fragmentation stays in each
   adapter's stream-translator tests.
4. **Usage** — the final chunk carries the exact normalized input/output token
   counts supplied by the fixture.
5. **Abort propagation** — the `abort` fixture keeps its fake backend pending
   until the adapter's cancellation mechanism fires, and remains pending when
   no cancellation mechanism reaches it. The suite first asserts that iteration
   has not settled, then aborts the signal passed to `provider.stream()`; the
   iteration must subsequently settle, either by completing or rejecting,
   within 1,000 ms. The suite does not require the adapter to forward the same
   signal object; converting it to a vendor-specific cancellation primitive is
   valid.
6. **Error normalization** — failures before output and failures during stream
   iteration reject with `ProviderError`; a numeric HTTP `status` is preserved.

The suite deliberately does not standardize malformed provider-native tool
JSON in this slice. Anthropic currently rejects it while OpenAI currently falls
back to `{}`. Changing that behavior requires a separate decision because it
can alter whether failure is classified as a provider error or tool-schema
error. The difference will be documented as a known adapter behavior rather
than silently changed here.

Provider-specific tests remain responsible for native request mapping:
system messages, tool-result history, JSON Schema conversion, sampling fields,
stop sequences, `toolChoice`, provider defaults, and SDK construction options.
The conformance suite supplements these tests; it does not replace them.

## 6. First-party test layout

Add a single conformance entry point in the provider package:

```text
packages/provider/test/
  conformance.test.ts
  support/
    anthropicConformance.ts
    openaiConformance.ts
```

`conformance.test.ts` loops over both factories and every exported case, matching
the style already used by checkpointer backends. Test drivers use only injected
clients and deterministic async iterables, so they are fast and offline.

Existing mapping, stream, factory/error, and retry tests stay where they are.
Only assertions made redundant by the new shared cases may be removed; native
mapping assertions and protocol edge cases must not be collapsed into the
generic suite.

## 7. Opt-in OpenAI-compatible smoke test

Add a smoke file that does not match Vitest's normal `*.test.*` / `*.spec.*`
discovery pattern, plus a dedicated Vitest config and package script:

```text
packages/provider/test/compat/openai-compatible.smoke.ts
packages/provider/vitest.compat.config.ts
```

```text
pnpm --filter @lite-agent/provider test:compat
```

The dedicated command reads:

- `LITE_AGENT_COMPAT_BASE_URL` — required endpoint root;
- `LITE_AGENT_COMPAT_MODEL` — required model id;
- `LITE_AGENT_COMPAT_API_KEY` — optional, defaults to `local`;
- `LITE_AGENT_COMPAT_FORCED_TOOL` — optional boolean, defaults to `false`.

Missing `LITE_AGENT_COMPAT_BASE_URL` or `LITE_AGENT_COMPAT_MODEL` fails
immediately with a configuration error, before constructing a client. Because
only the dedicated config includes the smoke file, default package and
workspace tests cannot activate it accidentally, even when compatibility
environment variables happen to exist. A non-empty forced-tool value other
than the exact strings `true` or `false` is also a configuration error.

When the probe is enabled, its base profile sends a short deterministic text
request and verifies:

- at least one text delta;
- exactly one final `message_done`;
- final text equals concatenated deltas; and
- usage is present as non-negative numeric fields. Zero usage is reported as
  unavailable, not treated as proof that the server supplied accounting data.

When `LITE_AGENT_COMPAT_FORCED_TOOL=true`, a second request forces a specifically
named `echo` tool and verifies a normalized tool call. Passing this profile
proves named forced-tool selection, which is deliberately narrower than the
broad claim "supports native tools". An endpoint may support automatic tool
calls but not this stronger control. Local models using `jsonCodec` or
`reactCodec` do not need to run the forced-tool profile.

The dedicated command and documentation make the opt-in network behavior
explicit. Each provider stream receives a request timeout shorter than the
Vitest case timeout, so a failed probe cancels its underlying HTTP request. No
credentials, endpoint outputs, or prompts are persisted.

## 8. Compatibility levels and documentation

The English and Simplified Chinese provider READMEs gain the same support
matrix and definitions:

| Level | Meaning |
| --- | --- |
| Maintained adapter | Repository-owned mapping and stream translator; passes offline conformance tests. |
| Maintained preset | Repository-owned endpoint/configuration preset using a maintained adapter; runtime and model capabilities still vary. |
| Compatible endpoint | User-supplied endpoint expected to speak the protocol; best-effort until its exact runtime/model profile passes the opt-in probe. |

The initial matrix records only evidence present in this repository:

- Anthropic Messages — maintained adapter.
- OpenAI Chat Completions — maintained adapter.
- Ollama, vLLM, LM Studio, llama.cpp — maintained local presets through
  `localOpenAI`; not a blanket claim that every model supports native tools or
  usage reporting.
- Other OpenAI-compatible endpoints — compatible endpoint, unverified by
  default.

The READMEs also document the smoke command and the meaning of the forced-tool
flag. Wording uses "verified for this endpoint/runtime/model profile" rather
than "certified provider".

The current provider README says the package root exports
`toAnthropicParams`, `toOpenAIParams`, and `translateStream`, while the public
root exports only factories and option/client types. The docs will be corrected
to describe those mapping helpers as internal. They will not be exported: both
adapters have a same-named `translateStream`, and exposing internals would add
an unnecessary compatibility commitment.

## 9. Error handling and reporting

- Offline conformance failures are ordinary assertion failures named by
  provider and contract case.
- Real-endpoint authentication, transport, rate-limit, or server failures stay
  `ProviderError`s with preserved numeric status where available.
- The smoke test must not catch and relabel provider failures as generic
  compatibility failures; the original message and status are needed for
  diagnosis.
- Missing required probe configuration fails before any network-capable client
  is constructed.
- Failure of forced named-tool selection affects only that optional profile,
  not the text transport profile, and must not be generalized to "no native
  tool support".

## 10. Package and file impact

```text
packages/core/src/testing/providerConformance.ts       # new public test utility
packages/core/src/index.ts                             # export utility + types
packages/core/test/provider-conformance.test.ts        # self-test with a minimal scripted provider
packages/provider/test/conformance.test.ts             # both first-party adapters
packages/provider/test/support/*.ts                    # injected-client drivers
packages/provider/test/compat/openai-compatible.smoke.ts # opt-in endpoint probe
packages/provider/vitest.compat.config.ts              # dedicated discovery
packages/provider/package.json                         # test:compat script
packages/provider/README.md                            # levels, matrix, probe, export correction
packages/provider/README.zh-CN.md                      # matching Chinese documentation
```

No production provider file, kernel file, normalized model type, SDK assembly,
CLI protocol selector, or local runtime preset changes in this slice.

## 11. Verification

Implementation follows TDD:

1. Add a failing core self-test that exercises the intended conformance cases.
2. Implement and export the framework-neutral suite.
3. Add failing Anthropic and OpenAI conformance drivers, then make both pass
   without changing observable behavior except where an actual contract defect
   is exposed and separately approved.
4. Add the opt-in smoke probe; verify the default suite does not discover it
   and missing dedicated-command configuration fails before client creation.
5. Update both READMEs and check the compatibility claims against executable
   tests and existing local presets.
6. Run the safe full check in topological order:

```text
pnpm -r build && pnpm -r test && pnpm -r typecheck
```

The real-endpoint probe is not part of the mandatory full check. When an
endpoint is available, record the exact runtime version, model id, date, and
which profiles passed in the change/PR notes; do not commit secrets.

## 12. Deferred provider expansion

A new native provider gets its own design only when at least one of these is
true:

- a real target cannot pass the OpenAI-compatible probe because its native
  authentication, request, streaming, or tool semantics differ;
- a committed product use case requires that provider's native API; or
- a provider-specific capability is approved for the normalized core model.

The default next candidate is a standalone Google Gemini adapter because it
tests a genuinely different protocol. Bedrock, Vertex, and Azure should be
prioritized instead when enterprise deployment evidence points there. Vendor
SDKs should live in separate provider packages once the first-party set grows,
so users do not install every provider dependency through one umbrella package.

## 13. Out of scope

- Gemini, Bedrock, Vertex, Azure, Groq, DeepSeek, or other new factories.
- Images, audio, reasoning blocks, citations, prompt-cache accounting,
  structured output, cost calculation, or richer stop reasons.
- Live endpoint tests in default CI.
- A permanent claim that all versions or models of a compatible runtime behave
  identically.
- Refactoring existing provider implementations beyond changes strictly needed
  to satisfy an approved shared contract.
