import { expect, test } from "vitest";
import { buildSystemPrompt } from "../src/system";

test("system prompt embeds workdir, model, skills, and load_skill hint", () => {
  const s = buildSystemPrompt({ workdir: "/w", modelName: "m1", skills: "  - demo: x" });
  expect(s).toContain("/w");
  expect(s).toContain("m1");
  expect(s).toContain("- demo: x");
  expect(s).toContain("load_skill");
});
