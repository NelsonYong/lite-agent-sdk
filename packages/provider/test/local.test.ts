import { expect, test, vi } from "vitest";
import { localOpenAI, isLoopbackEndpoint } from "../src/index";

test.each(["ollama", "vllm", "lm-studio", "llama.cpp"] as const)("%s creates a standard provider without eager network access", (runtime) => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  try {
    const provider = localOpenAI({ runtime, contextWindow: 8192 });
    expect(provider.context?.contextWindow).toBe(8192);
    expect(provider).not.toHaveProperty("local");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

test("local presets reject invalid capabilities and endpoints without claiming offline isolation", () => {
  expect(() => localOpenAI({ runtime: "ollama", contextWindow: NaN })).toThrow(/contextWindow/);
  expect(() => localOpenAI({ runtime: "ollama", baseURL: "https://remote.example/v1" })).toThrow(/loopback/);
  expect(isLoopbackEndpoint("http://127.0.0.1:11434/v1")).toBe(true);
  expect(isLoopbackEndpoint("http://[::1]:8000/v1")).toBe(true);
  for (const url of ["unix:/tmp/model.sock", "http://127.example.com", "ftp://localhost", "http://secret@localhost"]) expect(isLoopbackEndpoint(url)).toBe(false);
});

test("local provider forwards ordinary model calls through the existing OpenAI adapter", async () => {
  const requests: unknown[] = [];
  const provider = localOpenAI({ runtime: "ollama", client: { chat: { completions: { async *create(params) {
    requests.push(params);
    yield { id: "test", object: "chat.completion.chunk", created: 0, model: "test", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] };
    yield { id: "test", object: "chat.completion.chunk", created: 0, model: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  } } } } });
  const chunks = [];
  for await (const chunk of provider.stream({ model: "test", messages: [{ role: "user", content: "hello" }] })) chunks.push(chunk);
  expect(requests).toHaveLength(1);
  expect(chunks).toContainEqual({ type: "text_delta", text: "ok" });
});
