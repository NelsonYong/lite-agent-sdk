import { expect, test } from "vitest";
import { buildSystemPrompt } from "../src/system";

test("system prompt embeds workdir, model, skills, and load_skill hint", () => {
  const s = buildSystemPrompt({ workdir: "/w", modelName: "m1", skills: "  - demo: x" });
  expect(s).toContain("/w");
  expect(s).toContain("m1");
  expect(s).toContain("- demo: x");
  expect(s).toContain("load_skill");
  expect(s).toContain("TaskCreate");
  expect(s).toContain("delete_file");
});

test("includes a Subagents section listing types when subagents are provided", () => {
  const prompt = buildSystemPrompt({
    workdir: "/w",
    skills: "(no skills available)",
    subagents: "  - researcher: digs through code",
  });
  expect(prompt).toContain("## Subagents");
  expect(prompt).toContain("researcher: digs through code");
});

test("omits the Subagents section when none are provided", () => {
  const prompt = buildSystemPrompt({
    workdir: "/w",
    skills: "(no skills available)",
  });
  expect(prompt).not.toContain("## Subagents");
});
