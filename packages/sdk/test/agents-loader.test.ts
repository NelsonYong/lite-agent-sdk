import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoader } from "../src/agents/loader";

const dir = () => mkdtempSync(join(tmpdir(), "agents-"));

test("loads name, description, model and body from a .md file", () => {
  const d = dir();
  writeFileSync(
    join(d, "researcher.md"),
    "---\nname: researcher\ndescription: digs through code\nmodel: gpt-x\n---\nYou are a researcher.",
  );
  const loader = new AgentLoader(d);
  const def = loader.get("researcher")!;
  expect(def.description).toBe("digs through code");
  expect(def.model).toBe("gpt-x");
  expect(def.body).toBe("You are a researcher.");
  expect(loader.getDescriptions()).toContain("researcher: digs through code");
});

test("name falls back to the filename when frontmatter omits it", () => {
  const d = dir();
  writeFileSync(join(d, "reviewer.md"), "---\ndescription: reviews\n---\nBody");
  expect(new AgentLoader(d).names()).toEqual(["reviewer"]);
});

test("a later dir overrides an earlier dir on name collision", () => {
  const a = dir();
  const b = dir();
  writeFileSync(join(a, "x.md"), "---\nname: x\ndescription: from A\n---\nA BODY");
  writeFileSync(join(b, "x.md"), "---\nname: x\ndescription: from B\n---\nB BODY");
  const loader = new AgentLoader([a, b]);
  expect(loader.get("x")!.body).toBe("B BODY");
  expect(loader.get("x")!.description).toBe("from B");
});

test("tools parse from a YAML list", () => {
  const d = dir();
  writeFileSync(join(d, "a.md"), "---\nname: a\ndescription: d\ntools:\n  - bash\n  - read_file\n---\nB");
  expect(new AgentLoader(d).get("a")!.tools).toEqual(["bash", "read_file"]);
});

test("tools parse from a comma-separated string", () => {
  const d = dir();
  writeFileSync(join(d, "a.md"), "---\nname: a\ndescription: d\ntools: bash, read_file\n---\nB");
  expect(new AgentLoader(d).get("a")!.tools).toEqual(["bash", "read_file"]);
});

test("missing tools yields undefined (inherit)", () => {
  const d = dir();
  writeFileSync(join(d, "a.md"), "---\nname: a\ndescription: d\n---\nB");
  expect(new AgentLoader(d).get("a")!.tools).toBeUndefined();
});

test("unknown get returns null; empty loader reports a placeholder", () => {
  const loader = new AgentLoader(join(tmpdir(), "missing-agents-xyz"));
  expect(loader.get("nope")).toBeNull();
  expect(loader.names()).toEqual([]);
  expect(loader.getDescriptions()).toBe("(no subagents available)");
});
