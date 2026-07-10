import { expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissionFilePolicy } from "../src/permission/files";

const call = (name: string) => ({ id: "1", name, input: {} });

test("permission files merge layers globally with deny precedence and default deny", async () => {
  const root = mkdtempSync(join(tmpdir(), "perm-files-"));
  const home = join(root, "home");
  const workdir = join(root, "work");
  mkdirSync(join(workdir, ".lite-agent"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const managed = join(root, "managed.json");
  writeFileSync(managed, JSON.stringify({ version: 1, rules: [{ id: "no-bash", tool: "bash", effect: "deny" }] }));
  writeFileSync(join(workdir, ".lite-agent", "permissions.json"), JSON.stringify({
    version: 1, rules: [{ id: "yes-bash", tool: "bash", effect: "allow" }, { tool: "read_file", effect: "allow" }],
  }));
  const p = permissionFilePolicy({ workdir, home, managedFile: managed });

  expect(await p.check(call("bash"), { sessionId: "s" })).toMatchObject({ decision: "deny", ruleId: "managed:no-bash" });
  expect(await p.check(call("read_file"), { sessionId: "s" })).toMatchObject({ decision: "allow" });
  expect(await p.check(call("unknown"), { sessionId: "s" })).toBe("deny");
});

test("permission files hot reload and fail closed when a changed file becomes invalid", async () => {
  const root = mkdtempSync(join(tmpdir(), "perm-reload-"));
  const project = join(root, "permissions.json");
  writeFileSync(project, JSON.stringify({ version: 1, rules: [{ tool: "read_file", effect: "allow" }] }));
  const onReload = vi.fn();
  const p = permissionFilePolicy({
    workdir: root, home: root, userFile: false, projectFile: project, onReload,
  });
  expect(await p.check(call("read_file"), { sessionId: "s" })).toMatchObject({ decision: "allow" });

  writeFileSync(project, "not json");
  await expect(p.check(call("read_file"), { sessionId: "s" })).rejects.toThrow(/Invalid permission configuration/);
  expect(p.status().error).toBeTruthy();
  expect(onReload).toHaveBeenCalled();
});
