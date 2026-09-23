import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fakeProvider, policy, textBlock } from "@lite-agent/core";
import type { AgentEvent, ModelProvider } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { tool } from "../src/tool";
import { filePath } from "../src/permission/specifiers";
import { permissionFilePolicy } from "../src/permission/files";

test("default SDK settings reject file mutations without an approval handler", async () => {
  const root = mkdtempSync(join(tmpdir(), "default-policy-"));
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "w", name: "write_file", input: { path: "new.txt", content: "data" } }] } },
      { message: { role: "assistant", content: [textBlock("done")] } },
    ]),
    workdir: root, home: join(root, "home"), sessions: false, tasks: false, agents: false, cleanup: false,
  });
  try {
    const events: AgentEvent[] = [];
    for await (const event of agent.run("go")) events.push(event);
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "approval_resolved", decision: "deny", by: "auto" }));
  } finally { await agent.close(); }
});

test.each([undefined, policy({ allow: ["probe"] })])("children cannot widen the parent permission policy (%s)", async (subagentPermission) => {
  const root = mkdtempSync(join(tmpdir(), "child-permission-"));
  let ran = false;
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "p", name: "Agent", input: {
        tasks: [{ display_name: "Worker", subagent_type: "general-purpose", prompt: "go" }],
      } }] } },
      { message: { role: "assistant", content: [{ type: "tool_call", id: "c", name: "probe", input: {} }] } },
      { message: { role: "assistant", content: [textBlock("done")] } },
    ]),
    workdir: root, home: join(root, "home"), sessions: false, tasks: false, context: false, cleanup: false,
    tools: [tool("probe", "probe", z.object({}), () => { ran = true; return "ran"; })],
    permission: policy({ deny: ["probe"] }), subagentPermission,
  });
  try {
    await agent.send("go");
    await agent.awaitIdle();
    expect(ran).toBe(false);
  } finally { await agent.close(); }
});

test("file policy covers absolute, dot-segment and symlink aliases of the same target", async () => {
  const root = mkdtempSync(join(tmpdir(), "canonical-policy-"));
  mkdirSync(join(root, "private"));
  writeFileSync(join(root, "private", "secret"), "SYNTHETIC_SECRET");
  symlinkSync(join(root, "private"), join(root, "alias"));
  const paths = ["private/secret", join(root, "private/secret"), "public/../private/secret", "alias/secret"];
  for (const path of paths) {
    const agent = createLiteAgent({
      model: fakeProvider([
        { message: { role: "assistant", content: [{ type: "tool_call", id: "read", name: "read_file", input: { path } }] } },
        { message: { role: "assistant", content: [textBlock("done")] } },
      ]),
      workdir: root, home: join(root, "home"), sessions: false, tasks: false, agents: false, context: false, cleanup: false,
      permission: policy({ rules: [filePath("private/**", "deny")] }),
    });
    const events: AgentEvent[] = [];
    try {
      for await (const e of agent.run("go")) events.push(e);
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", result: expect.objectContaining({ isError: true }) }));
      expect(JSON.stringify(events)).not.toContain("SYNTHETIC_SECRET");
    } finally { await agent.close(); }
  }
});

test("repository permissions cannot grant capabilities or be rewritten by file tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "policy-authority-"));
  mkdirSync(join(root, ".lite-agent"));
  const file = join(root, ".lite-agent", "permissions.json");
  writeFileSync(file, JSON.stringify({ version: 1, rules: [{ tool: "bash", effect: "allow" }] }));
  const p = permissionFilePolicy({ workdir: root, home: root, managedFile: false, userFile: false,
    inlineRules: [{ tool: ["write_file", "delete_file"], effect: "allow" }],
  });
  const ctx = { sessionId: "s" };
  expect(await p.check({ id: "b", name: "bash", input: {} }, ctx)).toMatchObject({ decision: "deny" });
  for (const path of [file, ".lite-agent/permissions.json"])
    expect(await p.check({ id: "w", name: "write_file", input: { path } }, ctx)).toMatchObject({ decision: "deny" });
  expect(await p.check({ id: "d", name: "delete_file", input: { path: ".lite-agent" } }, ctx)).toMatchObject({ decision: "deny" });
});

test("parallel children share one approval queue and a denial does not stall the next request", async () => {
  const root = mkdtempSync(join(tmpdir(), "approval-queue-"));
  const counts = new Map<string, number>();
  let active = 0, peak = 0, approvals = 0, executions = 0;
  const model: ModelProvider = { id: "approval-test", async *stream(request) {
    const child = request.system?.startsWith('You are the "');
    const key = child ? String(request.messages[0]?.content) : "parent";
    const first = !counts.has(key);
    counts.set(key, 1);
    const content = first ? [{ type: "tool_call" as const, id: key, name: child ? "probe" : "Agent", input: child ? {} : {
      tasks: ["a", "b"].map((prompt) => ({ display_name: prompt, subagent_type: "general-purpose", prompt })),
    } }] : [textBlock("done")];
    yield { type: "message_done", message: { role: "assistant", content }, usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const agent = createLiteAgent({
    model, workdir: root, home: join(root, "home"), sessions: false, tasks: false, context: false, cleanup: false,
    tools: [tool("probe", "probe", z.object({}), () => { executions++; return "ok"; })],
    permission: policy({ ask: ["probe"] }),
    onApproval: { async request() {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return ++approvals === 1 ? "deny" : "allow";
    } },
  });
  try {
    await agent.send("go"); await agent.awaitIdle();
    expect(approvals).toBe(2);
    expect(peak).toBe(1);
    expect(executions).toBe(1);
  } finally { await agent.close(); }
});
