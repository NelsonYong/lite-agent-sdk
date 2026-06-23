import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@lite-agent/core";
import { SkillLoader } from "../src/skills/loader";
import { loadSkillTool } from "../src/skills/loadSkillTool";

const ctx: ToolContext = {
  sessionId: "s",
  signal: new AbortController().signal,
  emit: () => {},
};

test("loads frontmatter and serves the body via load_skill", async () => {
  const root = mkdtempSync(join(tmpdir(), "sk-"));
  mkdirSync(join(root, "demo"));
  writeFileSync(
    join(root, "demo", "SKILL.md"),
    "---\nname: demo\ndescription: a demo skill\n---\nBODY HERE",
  );

  const loader = new SkillLoader(root);
  expect(loader.getDescriptions()).toContain("demo: a demo skill");

  const tool = loadSkillTool(loader);
  expect(await tool.execute({ name: "demo" }, ctx)).toContain("BODY HERE");
  expect(await tool.execute({ name: "nope" }, ctx)).toMatch(/Unknown skill/);
});

test("empty/missing dir yields a placeholder description", () => {
  const loader = new SkillLoader(join(tmpdir(), "does-not-exist-xyz"));
  expect(loader.getDescriptions()).toBe("(no skills available)");
});

test("a later dir overrides an earlier dir on name collision", () => {
  const a = mkdtempSync(join(tmpdir(), "sk-a-"));
  const b = mkdtempSync(join(tmpdir(), "sk-b-"));
  mkdirSync(join(a, "demo"));
  mkdirSync(join(b, "demo"));
  writeFileSync(join(a, "demo", "SKILL.md"), "---\nname: demo\ndescription: from A\n---\nBODY A");
  writeFileSync(join(b, "demo", "SKILL.md"), "---\nname: demo\ndescription: from B\n---\nBODY B");

  const loader = new SkillLoader([a, b]);
  expect(loader.getContent("demo")).toContain("BODY B");
  expect(loader.getContent("demo")).not.toContain("BODY A");
});

test("names() lists loaded skills; a missing dir in the list is skipped", () => {
  const a = mkdtempSync(join(tmpdir(), "sk-a-"));
  mkdirSync(join(a, "demo"));
  writeFileSync(join(a, "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nB");

  const loader = new SkillLoader([join(tmpdir(), "missing-xyz"), a]);
  expect(loader.names()).toEqual(["demo"]);
});

test("parses YAML list frontmatter via gray-matter (tags as array)", () => {
  const root = mkdtempSync(join(tmpdir(), "sk-yaml-"));
  mkdirSync(join(root, "demo"));
  writeFileSync(
    join(root, "demo", "SKILL.md"),
    "---\nname: demo\ndescription: d\ntags:\n  - alpha\n  - beta\n---\nBODY",
  );
  const loader = new SkillLoader(root);
  expect(loader.getDescriptions()).toContain("alpha");
  expect(loader.getDescriptions()).toContain("beta");
});
