import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createLiteAgent } from "../src/createLiteAgent";
import { policy, defineTool, fakeProvider, textBlock } from "@lite-agent/core";
import type { AgentEvent, ApprovalHandler } from "@lite-agent/core";

function probeTool(ran: { value: boolean }) {
  return defineTool({
    name: "probe",
    description: "probe",
    schema: z.object({}),
    execute: () => {
      ran.value = true;
      return "executed";
    },
  });
}

function scriptedProvider() {
  return fakeProvider([
    {
      message: {
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "probe", input: {} }],
      },
    },
    {
      text: "done",
      message: { role: "assistant", content: [textBlock("done")] },
    },
  ]);
}

async function drain(gen: AsyncGenerator<AgentEvent, unknown>) {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return events;
}

test("onApproval deny short-circuits the gated tool", async () => {
  const ran = { value: false };
  const agent = createLiteAgent({
    model: scriptedProvider(),
    workdir: process.cwd(),
    tools: [probeTool(ran)],
    permission: policy({ ask: ["probe"] }),
    onApproval: {
      request: vi.fn(async (): Promise<"allow" | "deny"> => "deny"),
    } as ApprovalHandler,
  });
  const events = await drain(agent.run("go"));
  expect(ran.value).toBe(false);
  expect(events).toContainEqual(
    expect.objectContaining({ type: "approval_request" }),
  );
  const tr = events.find((e) => e.type === "tool_result");
  expect(tr).toMatchObject({
    result: { isError: true, content: "Error: denied by user" },
  });
});

test("onApproval allow lets the gated tool run", async () => {
  const ran = { value: false };
  const agent = createLiteAgent({
    model: scriptedProvider(),
    workdir: process.cwd(),
    tools: [probeTool(ran)],
    permission: policy({ ask: ["probe"] }),
    onApproval: { request: async (): Promise<"allow" | "deny"> => "allow" },
  });
  await drain(agent.run("go"));
  expect(ran.value).toBe(true);
});
