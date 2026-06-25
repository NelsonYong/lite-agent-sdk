import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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

test("description defaults to 'No description' when frontmatter omits it", () => {
  const d = dir();
  writeFileSync(join(d, "a.md"), "---\nname: a\n---\nBody");
  expect(new AgentLoader(d).get("a")!.description).toBe("No description");
});

test("recurses into subdirectories to find .md definitions", () => {
  const d = dir();
  mkdirSync(join(d, "nested"));
  writeFileSync(join(d, "nested", "deep.md"), "---\nname: deep\ndescription: nested agent\n---\nBody");
  expect(new AgentLoader(d).get("deep")!.description).toBe("nested agent");
});

test("list() returns every loaded definition", () => {
  const d = dir();
  writeFileSync(join(d, "a.md"), "---\nname: a\ndescription: da\n---\nA");
  writeFileSync(join(d, "b.md"), "---\nname: b\ndescription: db\n---\nB");
  const got = new AgentLoader(d).list().map((x) => x.name).sort();
  expect(got).toEqual(["a", "b"]);
});

test("ignores .md files that have no frontmatter (e.g. README)", () => {
  const d = dir();
  writeFileSync(join(d, "README.md"), "# Just docs\nno frontmatter here");
  writeFileSync(join(d, "real.md"), "---\nname: real\ndescription: a real agent\n---\nBody");
  const loader = new AgentLoader(d);
  expect(loader.names()).toEqual(["real"]);
  expect(loader.get("README")).toBeNull();
});
