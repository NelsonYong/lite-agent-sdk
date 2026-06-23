import { expect, test } from "vitest";
import { runKernel } from "../src/kernel";
import type { KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { noopSandbox } from "../src/sandbox";
import { retry } from "../src/retry";
import { ProviderError } from "../src/events";
import { textBlock } from "../src/types";
import type { ModelProvider } from "../src/strategies";
import type { AgentEvent, RunResult } from "../src/events";

function baseCfg(over: Partial<KernelConfig>): KernelConfig {
  return { provider: { id: "x", async *stream() {} }, codec: nativeCodec(), tools: [], middleware: [], model: "fake", maxTurns: 10, sandbox: noopSandbox(), ...over };
}

async function run(gen: AsyncGenerator<AgentEvent, RunResult>) {
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  return r.value;
}

const ok = (text: string) =>
  ({ type: "message_done" as const, message: { role: "assistant" as const, content: [textBlock(text)] }, usage: { inputTokens: 0, outputTokens: 0 } });

test("retry recovers from a transient ProviderError", async () => {
  let attempts = 0;
  const flaky: ModelProvider = {
    id: "flaky",
    async *stream() {
      attempts++;
      if (attempts === 1) throw new ProviderError("503", 503);
      yield ok("recovered");
    },
  };
  const result = await run(
    runKernel(baseCfg({ provider: flaky, middleware: [retry({ maxRetries: 2, backoff: () => 0 })] }), "hi", new AbortController().signal, "s1"),
  );
  expect(attempts).toBe(2);
  expect(result.text).toBe("recovered");
});

test("retry surfaces the error after exhausting maxRetries", async () => {
  let attempts = 0;
  const always: ModelProvider = {
    id: "always",
    async *stream() { attempts++; throw new ProviderError("503", 503); },
  };
  await expect(
    run(runKernel(baseCfg({ provider: always, middleware: [retry({ maxRetries: 2, backoff: () => 0 })] }), "hi", new AbortController().signal, "s1")),
  ).rejects.toThrow();
  expect(attempts).toBe(3); // 1 initial + 2 retries
});

test("retry does not retry a non-retryable status", async () => {
  let attempts = 0;
  const bad: ModelProvider = {
    id: "bad",
    async *stream() { attempts++; throw new ProviderError("400", 400); },
  };
  await expect(
    run(runKernel(baseCfg({ provider: bad, middleware: [retry({ maxRetries: 3, backoff: () => 0 })] }), "hi", new AbortController().signal, "s1")),
  ).rejects.toThrow();
  expect(attempts).toBe(1);
});

test("retry does not re-run once chunks have already streamed", async () => {
  let attempts = 0;
  const midFail: ModelProvider = {
    id: "mid",
    async *stream() {
      attempts++;
      yield { type: "text_delta", text: "partial" };
      throw new ProviderError("503", 503);
    },
  };
  await expect(
    run(runKernel(baseCfg({ provider: midFail, middleware: [retry({ maxRetries: 3, backoff: () => 0 })] }), "hi", new AbortController().signal, "s1")),
  ).rejects.toThrow();
  expect(attempts).toBe(1);
});
