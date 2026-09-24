import { expect, test, vi } from "vitest";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { providerConformance, ProviderError } from "@lite-agent/core";
import type { ModelRequest, ModelChunk, ProviderConformanceScenario } from "@lite-agent/core";
import { aiSdk } from "../src/index";
import { toAiPrompt } from "../src/ai-sdk/mapping";

const usage = (input = 2, output = 1): LanguageModelV4Usage => ({ inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: output, text: output, reasoning: undefined } });
const finish = (): LanguageModelV4StreamPart => ({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() });
const request: ModelRequest = { model: "conformance-model", messages: [{ role: "user", content: "hello" }] };
function model(parts: LanguageModelV4StreamPart[] = [], capture?: (opts: LanguageModelV4CallOptions) => void): LanguageModelV4 {
  return { specificationVersion: "v4", provider: "fixture.chat", modelId: request.model, supportedUrls: {},
    doGenerate: async () => { throw new Error("unused"); },
    doStream: async (opts) => {
      capture?.(opts);
      return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) };
    },
  };
}
async function collect(source: AsyncIterable<ModelChunk>) { const chunks: ModelChunk[] = []; for await (const chunk of source) chunks.push(chunk); return chunks; }

function conformance(scenario: ProviderConformanceScenario) {
  const parts: LanguageModelV4StreamPart[] = [];
  if (scenario.kind === "text" || scenario.kind === "tool") {
    for (const delta of scenario.kind === "text" ? scenario.deltas : scenario.textDeltas) parts.push({ type: "text-delta", id: "text", delta });
    if (scenario.kind === "tool") parts.push({ type: "tool-call", toolCallId: scenario.call.id, toolName: scenario.call.name, input: JSON.stringify(scenario.call.input) });
    parts.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(scenario.usage.inputTokens, scenario.usage.outputTokens) });
    return aiSdk(model(parts));
  }
  if (scenario.kind === "error") {
    if (scenario.afterText) parts.push({ type: "text-delta", id: "text", delta: scenario.afterText });
    parts.push({ type: "error", error: scenario.error });
    return aiSdk(model(parts));
  }
  return aiSdk({ ...model(), doStream: async () => ({ stream: new ReadableStream() }) });
}
for (const contract of providerConformance) test(`AI SDK contract: ${contract.name}`, () => contract.run(conformance));

test("maps tools, structured tool errors and standardized reasoning without another execution loop", async () => {
  let captured!: LanguageModelV4CallOptions;
  const provider = aiSdk(model([finish()], (opts) => { captured = opts; }), { providerOptions: { fixture: { extra: true } } });
  await collect(provider.stream({ ...request, system: "system", maxTokens: 100, reasoningEffort: "high", toolChoice: { tool: "lookup" }, tools: [{ name: "lookup", description: "lookup", parameters: { type: "object", properties: {} } }], messages: [
    { role: "assistant", content: [{ type: "tool_call", id: "c", name: "lookup", input: {} }] },
    { role: "user", content: [{ type: "tool_result", id: "c", content: "denied", isError: true }, { type: "text", text: "continue" }] },
  ] }));
  expect(captured).toMatchObject({ reasoning: "high", maxOutputTokens: 100, toolChoice: { type: "tool", toolName: "lookup" }, providerOptions: { fixture: { extra: true } }, tools: [{ type: "function", name: "lookup" }] });
  expect(captured.prompt).toEqual([
    { role: "system", content: "system" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "lookup", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "lookup", output: { type: "error-text", value: "denied" } }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ]);
});

test("reasoning, signatures, assistant phase and tool metadata survive a JSON checkpoint round trip", async () => {
  const provider = aiSdk(model([
    { type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: "think" },
    { type: "reasoning-end", id: "r", providerMetadata: { fixture: { signature: "signed" } } },
    { type: "text-delta", id: "t", delta: "working", providerMetadata: { fixture: { phase: "commentary" } } },
    { type: "tool-input-start", id: "c", toolName: "lookup", providerMetadata: { fixture: { thoughtSignature: "signed-call" } } },
    { type: "tool-input-delta", id: "c", delta: '{"value":' },
    { type: "tool-input-delta", id: "c", delta: '1}' }, { type: "tool-input-end", id: "c" },
    { type: "tool-call", toolCallId: "c", toolName: "lookup", input: '{"value":1}' }, finish(),
  ]));
  const chunks = await collect(provider.stream(request));
  const done = chunks.at(-1)!; if (done.type !== "message_done") throw new Error("missing message");
  const replay = JSON.parse(JSON.stringify(done.message));
  const prompt = toAiPrompt({ ...request, messages: [replay] }, "ai-sdk:fixture.chat:conformance-model");
  expect(prompt[0]).toMatchObject({ role: "assistant", content: [
    { type: "reasoning", text: "think", providerOptions: { fixture: { signature: "signed" } } },
    { type: "text", text: "working", providerOptions: { fixture: { phase: "commentary" } } },
    { type: "tool-call", toolCallId: "c", toolName: "lookup", input: { value: 1 }, providerOptions: { fixture: { thoughtSignature: "signed-call" } } },
  ] });
  expect(() => toAiPrompt({ ...request, messages: [replay] }, "ai-sdk:other:model")).toThrow(/different provider/);
  expect(chunks.filter((part) => part.type === "text_delta")).toEqual([{ type: "text_delta", text: "working" }]);
});

test("rejects legacy provider contracts, mismatched models, and unsupported settings", async () => {
  expect(() => aiSdk({ ...model(), specificationVersion: "v3" } as unknown as LanguageModelV4)).toThrow(/LanguageModelV4/);
  const source = model([finish()]); const call = vi.spyOn(source, "doStream");
  await expect(collect(aiSdk(source).stream({ ...request, model: "other" }))).rejects.toThrow(/Bound AI SDK model/);
  expect(call).not.toHaveBeenCalled();
  await expect(collect(aiSdk(model([{ type: "stream-start", warnings: [{ type: "unsupported", feature: "reasoning" }] }, finish()])).stream(request))).rejects.toThrow(/reasoning/);
});

test.each([
  [{ type: "tool-call", toolCallId: "c", toolName: "lookup", input: "{}", providerExecuted: true }],
  [{ type: "tool-input-start", id: "c", toolName: "lookup" }, finish()],
  [{ type: "tool-call", toolCallId: "c", toolName: "lookup", input: '{"bad"' }],
  [{ type: "text-delta", id: "t", delta: "partial" }],
  [{ type: "file", mediaType: "image/png", data: { type: "data", data: "AA==" } }],
] satisfies LanguageModelV4StreamPart[][])("fails explicitly instead of executing incomplete or unsupported output %#", async (...parts) => {
  await expect(collect(aiSdk(model(parts)).stream(request))).rejects.toBeInstanceOf(ProviderError);
});

test("early iterator return aborts transport work and cancels the response reader", async () => {
  let signal!: AbortSignal; const cancel = vi.fn();
  const provider = aiSdk({ ...model(), doStream: async (opts) => {
    signal = opts.abortSignal!;
    return { stream: new ReadableStream({ start(controller) { controller.enqueue({ type: "text-delta", id: "t", delta: "partial" }); }, cancel }) };
  } });
  const iterator = provider.stream(request)[Symbol.asyncIterator]();
  await iterator.next(); await iterator.return?.();
  expect(signal.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
});

test("cancellation also settles a provider that resolves doStream late", async () => {
  let release!: (value: Awaited<ReturnType<LanguageModelV4["doStream"]>>) => void;
  const cancel = vi.fn(); const pending = new Promise<Awaited<ReturnType<LanguageModelV4["doStream"]>>>((resolve) => { release = resolve; });
  const provider = aiSdk({ ...model(), doStream: () => pending });
  const controller = new AbortController();
  const run = collect(provider.stream(request, controller.signal));
  controller.abort(); await expect(run).rejects.toBeInstanceOf(ProviderError);
  release({ stream: new ReadableStream({ cancel }) });
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});

test("abort settles even if a third-party stream's cancellation hook stalls", async () => {
  const controller = new AbortController();
  const provider = aiSdk({ ...model(), doStream: async () => ({ stream: new ReadableStream({ cancel: () => new Promise(() => {}) }) }) });
  const run = collect(provider.stream(request, controller.signal));
  await Promise.resolve(); controller.abort();
  await expect(run).rejects.toBeInstanceOf(ProviderError);
});
