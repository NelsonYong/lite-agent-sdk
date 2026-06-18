import { expect, test } from "vitest";
import { z } from "zod";
import { createAgent } from "../src/createAgent";
import { nativeCodec } from "../src/codecs/native";
import { fakeProvider } from "../src/testing/fakeProvider";
import { defineTool } from "../src/tools/define";
import { noopSandbox } from "../src/sandbox";
import { textBlock } from "../src/types";

function probeAgent(sandbox?: { id: string; wrap: (c: string) => string }, seen: string[] = []) {
  const probe = defineTool({
    name: "probe",
    description: "report the sandbox id from context",
    schema: z.object({}),
    execute: (_i, ctx) => { seen.push(ctx.sandbox?.id ?? "absent"); return "ok"; },
  });
  return createAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "probe", input: {} }] } },
      { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
    ]),
    codec: nativeCodec(),
    tools: [probe],
    ...(sandbox ? { sandbox } : {}),
  });
}

test("noopSandbox returns the command unchanged", async () => {
  expect(await noopSandbox().wrap("echo hi", { cwd: "/tmp" })).toBe("echo hi");
  expect(noopSandbox().id).toBe("noop");
});

test("kernel threads the configured sandbox into ToolContext", async () => {
  const seen: string[] = [];
  await probeAgent({ id: "test-sb", wrap: (c) => c }, seen).send("go");
  expect(seen).toEqual(["test-sb"]);
});

test("ToolContext.sandbox defaults to noopSandbox when none configured", async () => {
  const seen: string[] = [];
  await probeAgent(undefined, seen).send("go");
  expect(seen).toEqual(["noop"]);
});
