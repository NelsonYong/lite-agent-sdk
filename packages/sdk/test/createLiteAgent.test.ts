import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";

test("runs with default tools wired", async () => {
  const agent = createLiteAgent({
    model: fakeProvider([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]),
    workdir: process.cwd(),
  });
  expect((await agent.send("hi")).text).toBe("ok");
});

test("load_skill is wired when skillsDir is set", async () => {
  const root = mkdtempSync(join(tmpdir(), "sk-"));
  mkdirSync(join(root, "demo"));
  writeFileSync(join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nBODY");
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "load_skill", input: { name: "demo" } }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: process.cwd(), skillsDir: root });
  const results: string[] = [];
  for await (const ev of agent.run("hi")) if (ev.type === "tool_result") results.push(ev.result.content);
  expect(results.join("")).toContain("BODY");
});

test("allowedTools restricts the registered set", async () => {
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "read_file", input: { path: "x" } }] } },
    { text: "end", message: { role: "assistant", content: [textBlock("end")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: process.cwd(), allowedTools: ["bash"] });
  const results: string[] = [];
  for await (const ev of agent.run("hi")) if (ev.type === "tool_result") results.push(ev.result.content);
  expect(results.join("")).toMatch(/unknown tool/);
});
