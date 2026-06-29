import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fakeProvider, textBlock } from "@lite-agent/core";
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
