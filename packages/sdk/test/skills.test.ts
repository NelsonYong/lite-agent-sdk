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
