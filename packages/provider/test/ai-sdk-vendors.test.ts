import { expect, test, vi } from "vitest";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createAzure } from "@ai-sdk/azure";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createGoogleVertex } from "@ai-sdk/google-vertex";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createXai } from "@ai-sdk/xai";
import { createMistral } from "@ai-sdk/mistral";
import { createGroq } from "@ai-sdk/groq";
import { createCohere } from "@ai-sdk/cohere";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createFireworks } from "@ai-sdk/fireworks";
import { createCerebras } from "@ai-sdk/cerebras";
import { createPerplexity } from "@ai-sdk/perplexity";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createMiniMax } from "@ai-sdk/minimax";
import { createZai } from "@ai-sdk/zai";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ModelRequest, ModelChunk, AssistantMessage } from "@lite-agent/core";
import { aiSdk } from "../src/index";
import { aiSdkWire } from "./support/aiSdkWire";
import type { Wire } from "./support/aiSdkWire";

type Settings = { apiKey: string; fetch: typeof fetch };
const vendors: Array<{ name: string; wire: Wire; build: (settings: Settings) => LanguageModelV4; noTools?: boolean }> = [
  { name: "OpenAI Responses", wire: "responses", build: (s) => createOpenAI(s)("gpt-5.4") },
  { name: "OpenAI Chat", wire: "chat", build: (s) => createOpenAI(s).chat("gpt-4.1") },
  { name: "Anthropic", wire: "anthropic", build: (s) => createAnthropic(s)("claude-sonnet-4-6") },
  { name: "Google Gemini", wire: "google", build: (s) => createGoogle(s)("gemini-3.1-pro-preview") },
  { name: "Azure", wire: "responses", build: (s) => createAzure({ ...s, resourceName: "fixture" })("gpt-5.4") },
  { name: "Amazon Bedrock", wire: "bedrock", build: (s) => createAmazonBedrock({ fetch: s.fetch, region: "us-east-1", accessKeyId: "fixture", secretAccessKey: "fixture" })("anthropic.claude-sonnet-4-6") },
  { name: "Google Vertex", wire: "google", build: (s) => createGoogleVertex({ ...s, project: "fixture", location: "us-central1" })("gemini-3.1-pro-preview") },
  { name: "DeepSeek", wire: "chat", build: (s) => createDeepSeek(s)("deepseek-chat") },
  { name: "xAI", wire: "responses", build: (s) => createXai(s)("grok-4.3") },
  { name: "Mistral", wire: "chat", build: (s) => createMistral(s)("mistral-large-latest") },
  { name: "Groq", wire: "chat", build: (s) => createGroq(s)("llama-3.3-70b-versatile") },
  { name: "Cohere", wire: "cohere", build: (s) => createCohere(s)("command-a-03-2025") },
  { name: "Together", wire: "chat", build: (s) => createTogetherAI(s)("fixture") },
  { name: "Fireworks", wire: "chat", build: (s) => createFireworks(s)("fixture") },
  { name: "Cerebras", wire: "chat", build: (s) => createCerebras(s)("fixture") },
  { name: "Perplexity", wire: "chat", build: (s) => createPerplexity(s)("sonar"), noTools: true },
  { name: "Alibaba Qwen", wire: "chat", build: (s) => createAlibaba(s)("qwen-plus") },
  { name: "Moonshot Kimi", wire: "chat", build: (s) => createMoonshotAI(s)("kimi-k2.5") },
  { name: "MiniMax", wire: "anthropic", build: (s) => createMiniMax(s)("minimax-m2.7") },
  { name: "Z.AI GLM", wire: "chat", build: (s) => createZai(s)("glm-5") },
  { name: "DeepInfra", wire: "chat", build: (s) => createDeepInfra(s)("fixture") },
  { name: "OpenRouter", wire: "chat", build: (s) => createOpenRouter(s)("fixture") },
  { name: "OpenAI-compatible (Doubao/Baidu/Tencent/SiliconFlow)", wire: "chat", build: (s) => createOpenAICompatible({ ...s, name: "host-endpoint", baseURL: "https://fixture.invalid/v1" })("deployment-id") },
];
async function final(provider: ReturnType<typeof aiSdk>, req: ModelRequest): Promise<Extract<ModelChunk, { type: "message_done" }>> {
  let done: Extract<ModelChunk, { type: "message_done" }> | undefined;
  for await (const chunk of provider.stream(req)) if (chunk.type === "message_done") done = chunk;
  if (!done) throw new Error("missing message");
  return done;
}
for (const vendor of vendors) {
  test(`${vendor.name}: actual provider streams and replays ${vendor.noTools ? "text" : "tool calls"}`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return aiSdkWire(vendor.wire, bodies.length === 1 && !vendor.noTools);
    }) as unknown as typeof fetch;
    const model = vendor.build({ apiKey: "fixture", fetch: fetchMock });
    const provider = aiSdk(model);
    const req: ModelRequest = { model: model.modelId, system: "system", maxTokens: 128, messages: [{ role: "user", content: "hello" }],
      ...(vendor.noTools ? {} : { tools: [{ name: "lookup", description: "lookup", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }] }) };
    const first = await final(provider, req);
    expect(first.usage.inputTokens).toBe(2); expect(first.usage.outputTokens).toBe(1);
    const replay = JSON.parse(JSON.stringify(first.message)) as AssistantMessage;
    if (vendor.noTools) {
      expect(replay.content).toContainEqual({ type: "text", text: "ok" });
    } else {
      const call = replay.content.find((block) => block.type === "tool_call");
      expect(call).toMatchObject({ name: "lookup", input: { value: "ok" } });
      if (call?.type !== "tool_call") throw new Error("missing tool call");
      const second = await final(provider, { ...req, messages: [...req.messages, replay, { role: "user", content: [{ type: "tool_result", id: call.id, content: "fixture-result", isError: true }] }] });
      expect(second.message.content).toContainEqual({ type: "text", text: "ok" });
      expect(JSON.stringify(bodies[1])).toContain("fixture-result");
      if (vendor.wire === "google") expect(JSON.stringify(bodies[1])).toContain("fixture-signature");
    }
  });
  test(`${vendor.name}: preserves HTTP failures without automatic retry`, async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "fixture failure", type: "rate_limit_error" }, message: "fixture failure" }), { status: 429, headers: { "content-type": "application/json" } }));
    const model = vendor.build({ apiKey: "fixture", fetch: fetchMock });
    await expect(final(aiSdk(model), { model: model.modelId, messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
}

test.each(["OpenAI Responses", "Anthropic", "Google Gemini"])("%s maps per-run reasoning effort through its official adapter", async (name) => {
  const vendor = vendors.find((entry) => entry.name === name)!;
  let body: Record<string, unknown> = {};
  const model = vendor.build({ apiKey: "fixture", fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return aiSdkWire(vendor.wire, false); } });
  await final(aiSdk(model), { model: model.modelId, messages: [{ role: "user", content: "hi" }], reasoningEffort: "high" });
  if (name === "OpenAI Responses") expect(body).toMatchObject({ reasoning: { effort: "high" } });
  if (name === "Anthropic") expect(body).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  if (name === "Google Gemini") expect(body).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: "high" } } });
});

test("OpenAI Responses preserves assistant phase when replaying the next user turn", async () => {
  const bodies: Record<string, unknown>[] = [];
  const model = createOpenAI({ apiKey: "fixture", fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return aiSdkWire("responses", false); } })("gpt-5.4");
  const provider = aiSdk(model, { providerOptions: { openai: { store: false } } });
  const req = { model: model.modelId, messages: [{ role: "user" as const, content: "hello" }] };
  const first = await final(provider, req);
  await final(provider, { ...req, messages: [...req.messages, first.message, { role: "user", content: "again" }] });
  expect(JSON.stringify(bodies[1])).toContain('"phase":"final_answer"');
});

test("OpenAI encrypted reasoning survives checkpoint replay with remote storage disabled", async () => {
  const bodies: Record<string, unknown>[] = [];
  const model = createOpenAI({ apiKey: "fixture", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length > 1) return aiSdkWire("responses", false);
    const reasoning = { type: "reasoning", id: "rs", summary: [{ type: "summary_text", text: "fixture thought" }], encrypted_content: "opaque-fixture-state" };
    const events = [
      { type: "response.created", response: { id: "r", created_at: 1, model: "gpt-5.4" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs", encrypted_content: null } },
      { type: "response.reasoning_summary_part.added", item_id: "rs", output_index: 0, summary_index: 0 },
      { type: "response.reasoning_summary_text.delta", item_id: "rs", output_index: 0, summary_index: 0, delta: "fixture thought" },
      { type: "response.reasoning_summary_part.done", item_id: "rs", output_index: 0, summary_index: 0 },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1 } } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } })("gpt-5.4");
  const provider = aiSdk(model, { providerOptions: { openai: { store: false } } });
  const req = { model: model.modelId, messages: [{ role: "user" as const, content: "hi" }] };
  const first = await final(provider, req);
  const restored = JSON.parse(JSON.stringify(first.message)) as AssistantMessage;
  await final(provider, { ...req, messages: [...req.messages, restored, { role: "user", content: "continue" }] });
  expect(bodies[1]).toMatchObject({ store: false });
  expect(JSON.stringify(bodies[1])).toContain('"encrypted_content":"opaque-fixture-state"');
});
