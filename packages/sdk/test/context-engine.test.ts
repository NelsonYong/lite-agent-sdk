import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fakeProvider, textBlock } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { resolveProjectPaths, sessionContextDir } from "../src/paths";
import { tool } from "../src/tool";
import { z } from "zod";

const workdir = () => mkdtempSync(join(tmpdir(), "sdk-context-"));

test("manual compact uses a derived context_view and keeps the raw transcript", async () => {
  const wd = workdir();
  const agent = createLiteAgent({
    model: fakeProvider([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]),
    workdir: wd,
  });
  const id = agent.sessionId;
  await agent.send("Goal: keep this exact fact");
  const result = await agent.send("Constraint: preserve the static prefix");
  expect(result.text).toBe("ok");

  const compacted: string[] = [];
  for await (const event of agent.compact()) if (event.type === "compaction" && event.phase === "done") compacted.push(event.kind);
  expect(compacted).toEqual(["manual"]);

  const { sessionsDir } = resolveProjectPaths({ workdir: wd, home: process.env.LITE_AGENT_HOME });
  const log = readFileSync(join(sessionsDir, `${id}.jsonl`), "utf8");
  expect(log).toContain('"type":"context_view"');
  expect(log).toContain("Goal: keep this exact fact");
});

test("context archive lives below the session sidecar and is retrievable through one tool", async () => {
  const wd = workdir();
  const large = "important output ".repeat(200);
  const read = tool("read_large", "read a large result", z.object({}), () => large);
  let call = 0;
  const provider = {
    id: "archive-provider",
    async *stream() {
      if (call++ === 0) {
        yield { type: "message_done" as const, message: { role: "assistant" as const, content: [{ type: "tool_call" as const, id: "r1", name: "read_large", input: {} }] }, usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "message_done" as const, message: { role: "assistant" as const, content: [textBlock("done")] }, usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
  const agent = createLiteAgent({ model: provider, tools: [read], workdir: wd });
  const id = agent.sessionId;
  await agent.send("Goal: inspect the result");
  for await (const _ of agent.compact()) { /* consume */ }

  const { sessionsDir } = resolveProjectPaths({ workdir: wd, home: process.env.LITE_AGENT_HOME });
  const sidecar = sessionContextDir(sessionsDir, id);
  expect(existsSync(join(sidecar, "index.jsonl"))).toBe(true);
  const refs = readFileSync(join(sidecar, "index.jsonl"), "utf8").trim().split("\n");
  expect(refs.length).toBeGreaterThan(0);
});
