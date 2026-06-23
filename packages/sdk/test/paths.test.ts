import { expect, test } from "vitest";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { liteAgentHome, projectHash, resolveProjectPaths } from "../src/paths";

test("liteAgentHome honors LITE_AGENT_HOME, else ~/.lite-agent", () => {
  const original = process.env.LITE_AGENT_HOME;
  try {
    process.env.LITE_AGENT_HOME = "/tmp/custom-home";
    expect(liteAgentHome()).toBe("/tmp/custom-home");
    delete process.env.LITE_AGENT_HOME;
    expect(liteAgentHome()).toBe(join(homedir(), ".lite-agent"));
  } finally {
    if (original === undefined) delete process.env.LITE_AGENT_HOME;
    else process.env.LITE_AGENT_HOME = original;
  }
});

test("projectHash is deterministic, absolute-resolved, and path-specific", () => {
  expect(projectHash("/a/b")).toBe(projectHash("/a/b"));
  expect(projectHash(".")).toBe(projectHash(resolve(".")));
  expect(projectHash("/a/b")).not.toBe(projectHash("/a/c"));
  expect(projectHash("/a/b")).toMatch(/^[0-9a-f]{16}$/);
});

test("resolveProjectPaths derives the project + global subpaths", () => {
  const p = resolveProjectPaths({ workdir: "/proj", home: "/home" });
  const projectDir = join("/home", "projects", projectHash("/proj"));
  expect(p).toEqual({
    home: "/home",
    hash: projectHash("/proj"),
    spillDir: join(projectDir, "spill"),
    sessionsDir: join(projectDir, "sessions"),
    globalSkillsDir: join("/home", "skills"),
    projectSkillsDir: join("/proj", ".lite-agent", "skills"),
  });
});
