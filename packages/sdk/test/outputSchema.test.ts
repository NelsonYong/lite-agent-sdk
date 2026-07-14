import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fakeProvider, textBlock } from "@lite-agent/core";
import type { ModelProvider } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";

const workdir = () => mkdtempSync(join(tmpdir(), "out-"));
const base = () => ({ workdir: workdir(), agents: false, tasks: false, sessions: false, cleanup: false, compactor: false as const });

const drain = async (gen: AsyncGenerator<unknown, { output?: unknown; text: string }>) => {
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  return r.value;
};

test("outputSchema registers final_answer and surfaces its validated input as result.output", async () => {
  const schema = z.object({ city: z.string(), tempC: z.number() });
  const fp = fakeProvider([
    // turn 1: the model calls final_answer with the structured result
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "f1", name: "final_answer", input: { city: "Beijing", tempC: 24 } },
    ] } },
    // turn 2: it sees the ack and stops
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, ...base(), outputSchema: schema });
  const res = await drain(agent.run("what's the weather in Beijing?"));
  expect(res.output).toEqual({ city: "Beijing", tempC: 24 });
});

test("without outputSchema there is no final_answer tool and output is undefined", async () => {
  const fp = fakeProvider([
    // the model tries to call final_answer, but it isn't registered
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "f1", name: "final_answer", input: { x: 1 } },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, ...base() });
  const types: string[] = [];
  const gen = agent.run("hi");
  let r = await gen.next();
  const results: string[] = [];
  while (!r.done) {
    types.push(r.value.type);
    if (r.value.type === "tool_result") results.push(String((r.value as { result: { content: string } }).result.content));
    r = await gen.next();
  }
  expect(results.join("")).toMatch(/unknown tool 'final_answer'/);
  expect(r.value.output).toBeUndefined();
});

test("invalid final_answer arguments are rejected by the schema (no output captured)", async () => {
  const schema = z.object({ city: z.string(), tempC: z.number() });
  const fp = fakeProvider([
    // tempC is a string — fails schema validation in the tool
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "f1", name: "final_answer", input: { city: "X", tempC: "hot" } },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, ...base(), outputSchema: schema });
  const res = await drain(agent.run("go"));
  expect(res.output).toBeUndefined();
});

test("final_answer survives both allow and deny filters", async () => {
  const schema = z.object({ answer: z.string() });
  const model = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [
          { type: "tool_call", id: "f1", name: "final_answer", input: { answer: "ready" } },
        ],
      },
    },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({
    model,
    ...base(),
    outputSchema: schema,
    allowedTools: [],
    disallowedTools: ["final_answer"],
  });

  expect((await agent.send("go")).output).toEqual({ answer: "ready" });
});

test("outputSchema appends its suffix to a custom system prompt", async () => {
  let seenSystem: string | undefined;
  const inner = fakeProvider([
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const model: ModelProvider = {
    id: "system-recorder",
    stream(request, signal) {
      seenSystem = request.system;
      return inner.stream(request, signal);
    },
  };
  const agent = createLiteAgent({
    model,
    ...base(),
    system: "CUSTOM SYSTEM",
    outputSchema: z.object({ answer: z.string() }),
  });

  await agent.send("go");

  expect(seenSystem).toBe(
    "CUSTOM SYSTEM\n\n## Final answer\n" +
      "When you have fully completed the task, you MUST call the `final_answer` tool " +
      "exactly once with your result. Do not put the final result in a normal message — " +
      "only the `final_answer` tool call is read as the answer.",
  );
});

test("without outputSchema preserves the raw result object shape", async () => {
  const agent = createLiteAgent({
    model: fakeProvider([
      { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
    ]),
    ...base(),
  });

  const result = await agent.send("go");

  expect(Object.hasOwn(result, "output")).toBe(false);
});
