import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock, memoryStore, defaultCompactor, ProviderError } from "@lite-agent/core";
import type { Message } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";

test("runs with default tools wired", async () => {
  const agent = createLiteAgent({
    model: fakeProvider([
      {
        text: "ok",
        message: { role: "assistant", content: [textBlock("ok")] },
      },
    ]),
    workdir: process.cwd(),
  });
  expect((await agent.send("hi")).text).toBe("ok");
});

test("load_skill is wired when skillsDir is set", async () => {
  const root = mkdtempSync(join(tmpdir(), "sk-"));
  mkdirSync(join(root, "demo"));
  writeFileSync(
    join(root, "demo", "SKILL.md"),
    "---\nname: demo\ndescription: d\n---\nBODY",
  );
  const fp = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "load_skill",
            input: { name: "demo" },
          },
        ],
      },
    },
    {
      text: "done",
      message: { role: "assistant", content: [textBlock("done")] },
    },
  ]);
  const agent = createLiteAgent({
    model: fp,
    workdir: process.cwd(),
    skillsDir: root,
  });
  const results: string[] = [];
  for await (const ev of agent.run("hi"))
    if (ev.type === "tool_result") results.push(ev.result.content);
  expect(results.join("")).toContain("BODY");
});

test("allowedTools restricts the registered set", async () => {
  const fp = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "read_file",
            input: { path: "x" },
          },
        ],
      },
    },
    {
      text: "end",
      message: { role: "assistant", content: [textBlock("end")] },
    },
  ]);
  const agent = createLiteAgent({
    model: fp,
    workdir: process.cwd(),
    allowedTools: ["bash"],
  });
  const results: string[] = [];
  for await (const ev of agent.run("hi"))
    if (ev.type === "tool_result") results.push(ev.result.content);
  expect(results.join("")).toMatch(/unknown tool/);
});

test("a configured store resumes the session across separate runs", async () => {
  const store = memoryStore();
  const make = (text: string) =>
    createLiteAgent({
      model: fakeProvider([{ text, message: { role: "assistant", content: [textBlock(text)] } }]),
      workdir: process.cwd(),
      store,
    });
  await make("one").send("first", { sessionId: "x" });
  const r2 = await make("two").send("second", { sessionId: "x" });
  expect(r2.messages).toContainEqual({ role: "user", content: "first" });
  expect(r2.messages).toContainEqual({ role: "user", content: "second" });
});

test("a configured compactor plugs in and emits compaction on a run", async () => {
  const shrink = {
    async maybeCompact(messages: { role: string; content: unknown }[]) {
      return messages.length <= 1
        ? { messages, before: 1, after: 1 }
        : { messages: [messages[0]!], kind: "micro" as const, before: 10, after: 1 };
    },
  };
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "bash", input: { command: "echo hi" } }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: process.cwd(), compactor: shrink as any });
  const types: string[] = [];
  for await (const ev of agent.run("hi")) types.push(ev.type);
  expect(types).toContain("compaction");
});

test("compactor wiring includes the reactive net — recovers from prompt_too_long", async () => {
  let calls = 0;
  const provider = {
    id: "ov",
    async *stream() {
      calls++;
      if (calls === 1) throw new ProviderError("prompt is too long", 413);
      yield { type: "message_done", message: { role: "assistant", content: [textBlock("ok")] }, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const turn = (u: string, id: string, r: string): Message[] => [
    { role: "user", content: u },
    { role: "assistant", content: [{ type: "tool_call", id, name: "f", input: {} }] },
    { role: "user", content: [{ type: "tool_result", id, content: r }] },
  ];
  const history = [0, 1, 2, 3, 4, 5].flatMap((i) => turn(`q${i}`, `c${i}`, `r${i}`));
  const agent = createLiteAgent({ model: provider as any, workdir: process.cwd(), compactor: defaultCompactor() });
  const result = await agent.send(history);
  expect(calls).toBe(2);
  expect(result.text).toBe("ok");
});

test("a configured sandbox wraps bash commands end-to-end", async () => {
  const fp = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "bash",
            input: { command: "echo original" },
          },
        ],
      },
    },
    {
      text: "done",
      message: { role: "assistant", content: [textBlock("done")] },
    },
  ]);
  const agent = createLiteAgent({
    model: fp,
    workdir: process.cwd(),
    sandbox: { id: "fake", wrap: () => "echo wrapped-by-sandbox" },
  });
  const results: string[] = [];
  for await (const ev of agent.run("hi"))
    if (ev.type === "tool_result") results.push(ev.result.content);
  expect(results.join("")).toContain("wrapped-by-sandbox");
  expect(results.join("")).not.toContain("original");
});
