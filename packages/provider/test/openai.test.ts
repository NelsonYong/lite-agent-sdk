import { expect, test } from "vitest";
import { openai } from "../src/openai/openai";
import type { OpenAIClientLike } from "../src/openai/openai";

async function* one() { yield { choices: [{ delta: { content: "hi" } }] } as never; yield { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } } as never; }

test("streams via an injected client", async () => {
  const client: OpenAIClientLike = { chat: { completions: { create: () => one() } } };
  const p = openai({ client });
  const out: string[] = [];
  for await (const c of p.stream({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
    if (c.type === "text_delta") out.push(c.text);
  }
  expect(out).toEqual(["hi"]);
  expect(p.id).toBe("openai");
});

test("wraps client errors in ProviderError preserving status", async () => {
  const client: OpenAIClientLike = { chat: { completions: { create: () => { throw Object.assign(new Error("boom"), { status: 429 }); } } } };
  const p = openai({ client });
  await expect((async () => { for await (const _ of p.stream({ model: "m", messages: [] })) { /* drain */ } })())
    .rejects.toMatchObject({ name: "ProviderError", status: 429 });
});
