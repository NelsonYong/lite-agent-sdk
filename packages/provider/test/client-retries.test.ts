import { vi, expect, test } from "vitest";

// Capture the options each SDK client is constructed with, without touching the network.
const { openaiArgs, anthropicArgs } = vi.hoisted(() => ({
  openaiArgs: [] as Array<Record<string, unknown>>,
  anthropicArgs: [] as Array<Record<string, unknown>>,
}));
vi.mock("openai", () => ({ default: class { constructor(o: Record<string, unknown>) { openaiArgs.push(o); } } }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { constructor(o: Record<string, unknown>) { anthropicArgs.push(o); } } }));

import { openai } from "../src/openai/openai";
import { anthropic } from "../src/anthropic/anthropic";

test("both providers default the SDK's internal retries to 0 (delegated to retry() middleware)", () => {
  openai({ apiKey: "k" });
  anthropic({ apiKey: "k" });
  expect(openaiArgs.at(-1)?.maxRetries).toBe(0);
  expect(anthropicArgs.at(-1)?.maxRetries).toBe(0);
});

test("both providers honor an explicit maxRetries", () => {
  openai({ apiKey: "k", maxRetries: 5 });
  anthropic({ apiKey: "k", maxRetries: 3 });
  expect(openaiArgs.at(-1)?.maxRetries).toBe(5);
  expect(anthropicArgs.at(-1)?.maxRetries).toBe(3);
});
