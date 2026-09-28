import { afterEach, expect, test, vi } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fakeProvider, memoryCheckpointer, policy, textBlock } from "@lite-agent/core";
import type { ModelProvider, SessionEvent } from "@lite-agent/core";
import { fileCheckpointer } from "../src/checkpoint";
import { fileContextArchive } from "../src/contextArchive";
import { fileTaskStore } from "../src/tasks/store";
import { fileSpillStore } from "../src/spill";
import { createLiteAgent } from "../src/createLiteAgent";
import { resolveProjectPaths, sessionContextDir } from "../src/paths";
import { loadHookFiles } from "../src/hooks/files";
import { permissionFilePolicy } from "../src/permission/files";
import { sweepStale } from "../src/cleanup";
import type { StorageCodec, StorageContext } from "../src/storage";

const roots: string[] = [];
const dir = () => { const value = mkdtempSync(join(tmpdir(), "agent-storage-")); roots.push(value); return value; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const event = (content = "PRIVATE_PAYLOAD"): SessionEvent => ({ type: "user", message: { role: "user", content } });
const reply = () => fakeProvider([{ message: { role: "assistant", content: [textBlock("done")] } }]);

// Node's authenticated encryption, with async callbacks and logical scope as AAD.
function encrypted(seen: StorageContext[] = []): StorageCodec {
  const key = randomBytes(32);
  return {
    id: "test-aes-gcm-v1",
    async encode(bytes, ctx) {
      await Promise.resolve();
      seen.push(ctx);
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(JSON.stringify(ctx)));
      const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async decode(bytes, ctx) {
      await Promise.resolve();
      const value = Buffer.from(bytes), decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAAD(Buffer.from(JSON.stringify(ctx)));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
    },
  };
}
const files = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);

test("namespace derives every directory and isolates legacy environment settings", () => {
  vi.stubEnv("LITE_AGENT_HOME", "/old-agent");
  const paths = resolveProjectPaths({ workdir: "/project", storage: { namespace: "acme" } });
  expect(paths.home).toBe(join(homedir(), ".acme"));
  expect(paths.projectConfigDir).toBe("/project/.acme");
  expect(paths.projectSkillsDir).toBe("/project/.acme/skills");
  expect(paths.projectAgentsDir).toBe("/project/.acme/agents");
  expect(paths.globalSkillsDir).toBe(join(homedir(), ".acme/skills"));
  expect(paths.sessionsDir).toContain(join(".acme", "projects", paths.hash));
  expect(resolveProjectPaths({ workdir: "/project" }).home).toBe("/old-agent");
});

test.each(["../escape", "/root", ".git", "", "a/b", "a\\b", "Mixed", "a".repeat(65)])("rejects invalid namespace %s", (namespace) => {
  expect(() => resolveProjectPaths({ workdir: "/project", storage: { namespace } })).toThrow(/namespace/);
});

test("conflicting homes and invalid codecs fail before runtime data is written", () => {
  const workdir = dir(), home = join(workdir, "data");
  expect(() => createLiteAgent({ model: reply(), workdir, home, storage: { home: join(home, "other") } })).toThrow(/conflict/);
  expect(() => createLiteAgent({ model: reply(), workdir, storage: { home, codec: { id: "bad id" } as StorageCodec } })).toThrow(/codec/);
  expect(existsSync(home)).toBe(false);
});

test("hooks, MCP, skills, agents and permission config follow the custom namespace without old-root fallback", async () => {
  const workdir = dir(), home = dir(), storage = { namespace: "acme", home };
  const paths = resolveProjectPaths({ workdir, storage });
  mkdirSync(paths.projectConfigDir);
  mkdirSync(join(workdir, ".lite-agent"));
  for (const name of ["hooks.json", "mcps.json", "permissions.json"])
    writeFileSync(join(workdir, ".lite-agent", name), "INVALID OLD CONFIG");
  writeFileSync(join(home, "hooks.json"), JSON.stringify({ version: 1, hooks: { "run:start": [{ command: "true" }] } }));
  writeFileSync(join(paths.projectConfigDir, "hooks.json"), JSON.stringify({ version: 1, hooks: { "run:end": [{ command: "true" }] } }));
  writeFileSync(join(paths.projectConfigDir, "mcps.json"), JSON.stringify({ mcpServers: { example: { command: "never-executed" } } }));
  writeFileSync(join(paths.projectConfigDir, "permissions.json"), JSON.stringify({ version: 1, rules: [{ tool: "bash", effect: "deny" }] }));
  const agent = createLiteAgent({ model: reply(), workdir, storage });
  expect(agent.mcp.list()).toMatchObject([{ name: "example", source: "project", status: "configured" }]);
  expect(loadHookFiles(paths.home, workdir, paths.projectConfigDir).map((h) => h.source)).toEqual(["global", "project"]);
  const permission = permissionFilePolicy({ workdir, storage, managedFile: false, default: "allow" });
  expect(await permission.check({ id: "1", name: "bash", input: {} }, { sessionId: "s" })).toMatchObject({ decision: "deny" });
  await agent.close();
});

test("checkpoint restart, optimistic concurrency, truncate and cleanup work with encoded records", async () => {
  const home = dir(), path = resolveProjectPaths({ workdir: dir(), storage: { home, namespace: "acme" } });
  const options = { dir: path.sessionsDir, codec: encrypted(), namespace: "acme", projectId: path.hash };
  const a = fileCheckpointer(options), b = fileCheckpointer(options);
  const results = await Promise.allSettled([a.append("s", [event()], 0), b.append("s", [event()], 0)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  await a.append("s", [event("SECOND_PRIVATE_PAYLOAD")], 1);
  const pathName = join(path.sessionsDir, "s.jsonl");
  const first = readFileSync(pathName, "utf8").split("\n")[0];
  expect(readFileSync(pathName, "utf8")).not.toContain("PRIVATE_PAYLOAD");
  sweepStale({ home });
  expect(await b.head("s")).toBe(2);
  await b.truncate!("s", 1, 2);
  expect(readFileSync(pathName, "utf8").trim()).toBe(first);
  const entries = [];
  for await (const entry of fileCheckpointer(options).read("s")) entries.push(entry.event);
  expect(entries).toEqual([event()]);
  expect(statSync(pathName).mode & 0o777).toBe(0o600);
});

test("a failed encode cannot append a partial batch or leak callback errors", async () => {
  const folder = dir(), good = encrypted();
  const codec: StorageCodec = { ...good, async encode(bytes, ctx) {
    if (ctx.recordId === "3") throw new Error("PRIVATE_KEY_AND_PAYLOAD");
    return good.encode(bytes, ctx);
  } };
  const cp = fileCheckpointer({ dir: folder, codec });
  await cp.append("s", [event()]);
  const before = readFileSync(join(folder, "s.jsonl"));
  await expect(cp.append("s", [event("second"), event("third")], 1)).rejects.toThrow(/^Storage encode failed/);
  expect(readFileSync(join(folder, "s.jsonl"))).toEqual(before);
  expect(await cp.head("s")).toBe(1);
  expect(files(folder)).toEqual([join(folder, "s.jsonl")]);
});

test("wrong keys, codec ids, missing codecs and corrupt encoded tails never trigger repair or plaintext fallback", async () => {
  const folder = dir(), codec = encrypted();
  await fileCheckpointer({ dir: folder, codec }).append("s", [event()]);
  const file = join(folder, "s.jsonl"), before = readFileSync(file, "utf8");
  for (const candidate of [undefined, encrypted(), { ...codec, id: "different-v2" }]) {
    await expect(fileCheckpointer({ dir: folder, codec: candidate, repairTail: true }).head("s")).rejects.toThrow(/Storage|storage/);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
  writeFileSync(file, before + '{"liteAgentStorage":1');
  await expect(fileCheckpointer({ dir: folder, codec, repairTail: true }).head("s")).rejects.toThrow(/Storage/);
  expect(readFileSync(file, "utf8")).toBe(before + '{"liteAgentStorage":1');
  sweepStale({ home: folder });
});

test("tasks encode all fields, round-trip after restart and retain locks across async updates", async () => {
  const folder = dir(), codec = encrypted(), opts = { dir: folder, listId: "shared", codec };
  const a = fileTaskStore(opts), b = fileTaskStore(opts);
  await Promise.all([a.create({ subject: "PRIVATE_PAYLOAD", description: "secret" }), b.create({ subject: "other", description: "secret" })]);
  expect((await b.list()).map((t) => t.id)).toEqual(["1", "2"]);
  await b.update({ taskId: "2", addBlockedBy: ["1"] });
  expect((await a.get("1"))?.blocks).toEqual(["2"]);
  for (const file of files(folder)) expect(readFileSync(file, "utf8")).not.toMatch(/PRIVATE_PAYLOAD|secret/);
  await expect(fileTaskStore({ ...opts, codec: encrypted() }).list()).rejects.toThrow(/decode/);
});

test("task dependency updates encode every touched record before committing", async () => {
  const folder = dir(), good = encrypted();
  let fail = false;
  const codec: StorageCodec = { ...good, encode(bytes, ctx) {
    if (fail && ctx.recordId === "2") throw new Error("private");
    return good.encode(bytes, ctx);
  } };
  const store = fileTaskStore({ dir: folder, listId: "s", codec });
  await store.create({ subject: "one", description: "" });
  await store.create({ subject: "two", description: "" });
  const before = files(folder).map((file) => readFileSync(file, "utf8"));
  fail = true;
  await expect(store.update({ taskId: "1", addBlocks: ["2"] })).rejects.toThrow(/encode/);
  expect(files(folder).map((file) => readFileSync(file, "utf8"))).toEqual(before);
});

test("archive body, preview and metadata are encoded; moving home preserves refs and wrong scopes fail", async () => {
  const folder = dir(), codec = encrypted(), scope = { codec, namespace: "acme", projectId: "project", sessionId: "s" };
  const archive = fileContextArchive({ dir: folder, ...scope });
  const content = "PRIVATE_PAYLOAD界".repeat(2000);
  const { ref } = await archive.put(content, { path: "PRIVATE_FILENAME" });
  for (const file of files(folder)) expect(readFileSync(file, "utf8")).not.toMatch(/PRIVATE_PAYLOAD|PRIVATE_FILENAME/);
  const moved = join(dir(), "moved");
  cpSync(folder, moved, { recursive: true });
  const fresh = fileContextArchive({ dir: moved, ...scope });
  expect(await fresh.search("PRIVATE_PAYLOAD")).toContain(ref);
  expect(await fresh.read(ref, 1, { offset: content.length - 16 })).toContain("PRIVATE_PAYLOAD");
  await expect(fileContextArchive({ dir: moved, ...scope, sessionId: "other" }).read(ref, 1)).rejects.toThrow(/decode/);
  await expect(fileContextArchive({ dir: moved }).read(ref, 1)).rejects.toThrow(/codec/);
});

test("failed index encoding leaves no plaintext or partially committed archive note", async () => {
  const folder = dir(), base = encrypted();
  const archive = fileContextArchive({ dir: folder, codec: { ...base, encode(bytes, ctx) {
    if (ctx.kind === "archive-index") throw new Error("private");
    return base.encode(bytes, ctx);
  } } });
  await expect(archive.put("PRIVATE_PAYLOAD")).rejects.toThrow(/encode/);
  expect(files(folder)).toEqual([]);
});

test("legacy spill storage also encodes and retrieves data through its codec", async () => {
  const folder = dir(), codec = encrypted();
  const ref = await fileSpillStore({ dir: folder, codec }).put("PRIVATE_PAYLOAD");
  expect(await fileSpillStore({ dir: folder, codec }).get(ref)).toBe("PRIVATE_PAYLOAD");
  expect(readFileSync(files(folder)[0]!, "utf8")).not.toContain("PRIVATE_PAYLOAD");
});

test("agent integration encodes snapshots, tasks and archives and retrieves large data by ref", async () => {
  const workdir = dir(), home = dir(), seen: StorageContext[] = [], codec = encrypted(seen);
  writeFileSync(join(workdir, "file.txt"), "PRIVATE_BEFORE_SNAPSHOT");
  const large = "PRIVATE_LARGE_CONTENT".repeat(10000) + "TAIL_MARKER";
  writeFileSync(join(workdir, "large.txt"), large);
  let step = 0;
  const received: string[] = [];
  const model: ModelProvider = { id: "storage-test", async *stream(req) {
    const text = JSON.stringify(req.messages);
    received.push(text);
    const ref = text.match(/archived: ([a-f0-9]{64})/)?.[1];
    const calls = [
      { name: "TaskCreate", input: { subject: "PRIVATE_TASK", description: "PRIVATE_DESCRIPTION" } },
      { name: "write_file", input: { path: "file.txt", content: "PRIVATE_AFTER_SNAPSHOT" } },
      { name: "read_file", input: { path: "large.txt" } },
      { name: "context", input: { ref, offset: large.length - 11 } },
    ];
    const call = calls[step++];
    yield { type: "message_done", message: { role: "assistant", content: call
      ? [{ type: "tool_call", id: String(step), ...call }] : [textBlock("done")] }, usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const agent = createLiteAgent({ model, workdir, storage: { namespace: "acme", home, codec }, permission: policy({ default: "allow" }), agents: false });
  await agent.send("PRIVATE_PROMPT");
  expect(received.at(-1)).toContain("TAIL_MARKER");
  expect(received[3]).not.toContain("TAIL_MARKER");
  expect(new Set(seen.map((ctx) => ctx.kind))).toEqual(new Set(["checkpoint", "task", "archive", "archive-index"]));
  expect(seen.every((ctx) => ctx.namespace === "acme" && Object.isFrozen(ctx))).toBe(true);
  for (const file of files(home)) expect(readFileSync(file, "utf8")).not.toContain("PRIVATE_");
  const sessionId = agent.sessionId;
  await agent.close();
  const fresh = createLiteAgent({ model: reply(), workdir, storage: { namespace: "acme", home, codec }, tasks: false, agents: false });
  await fresh.resume(sessionId);
  expect((await fresh.send("continue")).text).toBe("done");
  await fresh.deleteSession(sessionId);
  const paths = resolveProjectPaths({ workdir, storage: { namespace: "acme", home } });
  expect(existsSync(join(paths.sessionsDir, `${sessionId}.jsonl`))).toBe(false);
  expect(existsSync(sessionContextDir(paths.sessionsDir, sessionId))).toBe(false);
  expect(existsSync(join(paths.tasksDir, sessionId))).toBe(false);
  await fresh.close();
});

test("custom checkpointers keep their own serialization while built-in stores use storage.codec", async () => {
  const seen: StorageContext[] = [], cp = memoryCheckpointer();
  const agent = createLiteAgent({ model: reply(), workdir: dir(), storage: { home: dir(), codec: encrypted(seen) }, checkpointer: cp, agents: false, tasks: false });
  await agent.send("PRIVATE_PROMPT");
  expect(await cp.head(agent.sessionId)).toBeGreaterThan(0);
  expect(seen.some((ctx) => ctx.kind === "checkpoint")).toBe(false);
  await agent.close();
});

test("children inherit frozen storage and load definitions and skills from the custom project directory", async () => {
  const workdir = dir(), home = dir(), unused = dir(), seen: StorageContext[] = [];
  const storage = { namespace: "acme", home, codec: encrypted(seen) };
  const paths = resolveProjectPaths({ workdir, storage });
  mkdirSync(paths.projectAgentsDir, { recursive: true });
  mkdirSync(join(paths.projectSkillsDir, "helper"), { recursive: true });
  writeFileSync(join(paths.projectAgentsDir, "worker.md"), "---\nname: worker\ndescription: custom worker\n---\nPRIVATE_WORKER_INSTRUCTIONS");
  writeFileSync(join(paths.projectSkillsDir, "helper", "SKILL.md"), "---\nname: helper\ndescription: custom skill description\n---\nPRIVATE_SKILL_INSTRUCTIONS");
  let parentTurns = 0, childTurns = 0;
  const systems: string[] = [];
  const model: ModelProvider = { id: "family", async *stream(req) {
    systems.push(req.system ?? "");
    const child = req.system?.startsWith('You are the "worker"');
    const content = child
      ? childTurns++ === 0 ? [{ type: "tool_call" as const, id: "skill", name: "load_skill", input: { name: "helper" } }] : [textBlock("child finished")]
      : parentTurns++ === 0 ? [{ type: "tool_call" as const, id: "dispatch", name: "Agent", input: {
        tasks: [{ display_name: "Check", subagent_type: "worker", prompt: "PRIVATE_CHILD_PROMPT" }],
      } }] : [textBlock("parent finished")];
    yield { type: "message_done", message: { role: "assistant", content }, usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const agent = createLiteAgent({ model, workdir, storage });
  storage.home = unused;
  storage.namespace = "changed";
  vi.stubEnv("LITE_AGENT_HOME", unused);
  vi.stubEnv("LITE_AGENT_TASK_LIST_ID", "injected-after-creation");
  await agent.send("delegate to worker");
  await agent.awaitIdle();
  expect(childTurns).toBe(2);
  expect(systems[0]).toContain("custom skill description");
  expect(systems[0]).toContain("custom worker");
  const scopes = new Set(seen.filter((ctx) => ctx.kind === "checkpoint").map((ctx) => ctx.scopeId));
  expect(scopes.size).toBeGreaterThanOrEqual(2);
  expect(seen.every((ctx) => ctx.namespace === "acme")).toBe(true);
  expect(files(unused)).toEqual([]);
  for (const file of files(home)) expect(readFileSync(file, "utf8")).not.toContain("PRIVATE_");
  await agent.close();
});

test("encoded archives remain session-scoped and do not grant raw filesystem access", async () => {
  const workdir = dir(), home = dir(), codec = encrypted();
  const storage = { namespace: "acme", home, codec }, paths = resolveProjectPaths({ workdir, storage });
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  let step = 0;
  const model: ModelProvider = { id: "boundaries", async *stream() {
    const call = calls[step++];
    yield { type: "message_done", message: { role: "assistant", content: call
      ? [{ type: "tool_call", id: String(step), ...call }] : [textBlock("done")] }, usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const agent = createLiteAgent({ model, workdir, storage, tasks: false, agents: false });
  const ownDir = sessionContextDir(paths.sessionsDir, agent.sessionId);
  const own = fileContextArchive({ dir: ownDir, codec, namespace: paths.namespace, projectId: paths.hash, sessionId: agent.sessionId });
  const other = fileContextArchive({ dir: sessionContextDir(paths.sessionsDir, "other"), codec, namespace: paths.namespace, projectId: paths.hash, sessionId: "other" });
  const ownRef = (await own.put("OWN_CONTENT")).ref, otherRef = (await other.put("OTHER_CONTENT")).ref;
  calls.push({ name: "read_file", input: { path: join(ownDir, "notes", `${ownRef}.md`) } },
    { name: "context", input: { ref: otherRef } }, { name: "context", input: { ref: ownRef } });
  const results: string[] = [];
  for await (const item of agent.run("inspect")) if (item.type === "tool_result") results.push(item.result.content);
  expect(results[0]).toMatch(/Error|denied/i);
  expect(results[1]).toContain("No archived content");
  expect(results[2]).toContain("OWN_CONTENT");
  expect(results.join(" ")).not.toContain("OTHER_CONTENT");
  await agent.close();
});

test("plaintext runtime records require an explicit migration before enabling a codec", async () => {
  const folder = dir();
  await fileCheckpointer({ dir: folder }).append("s", [event()]);
  const before = readFileSync(join(folder, "s.jsonl"));
  await expect(fileCheckpointer({ dir: folder, codec: encrypted() }).append("s", [event("new")])).rejects.toThrow(/migration/);
  expect(readFileSync(join(folder, "s.jsonl"))).toEqual(before);
});


test("runtime stores reject symlink records and directory replacement", async () => {
  const folder = dir(), outside = dir(), codec = encrypted();
  const cp = fileCheckpointer({ dir: folder, codec });
  await cp.append("s", [event()]);
  renameSync(join(folder, "s.jsonl"), join(outside, "s.jsonl"));
  symlinkSync(join(outside, "s.jsonl"), join(folder, "s.jsonl"));
  await expect(cp.head("s")).rejects.toThrow(/Symlink/);
  const archiveDir = join(dir(), "archive"), archive = fileContextArchive({ dir: archiveDir, codec });
  await archive.put("PRIVATE_PAYLOAD");
  renameSync(archiveDir, `${archiveDir}-old`);
  mkdirSync(archiveDir);
  await expect(archive.put("new")).rejects.toThrow(/directory changed/);
});

test("cleanup cannot traverse symlink projects or delete logs with active codec locks", () => {
  const home = dir(), outside = dir();
  mkdirSync(join(home, "projects"));
  mkdirSync(join(outside, "sessions"));
  const secret = join(outside, "sessions", "s.jsonl");
  writeFileSync(secret, "PRIVATE_PAYLOAD");
  utimesSync(secret, 1, 1);
  symlinkSync(outside, join(home, "projects", "external"));
  const sessions = join(home, "projects", "local", "sessions");
  mkdirSync(sessions, { recursive: true });
  const active = join(sessions, "s.jsonl");
  writeFileSync(active, "opaque data");
  utimesSync(active, 1, 1);
  mkdirSync(`${active}.lock`);
  sweepStale({ home, maxBytes: 0 });
  expect(existsSync(secret)).toBe(true);
  expect(existsSync(active)).toBe(true);
});


test("file session and task-list ids cannot alias through filename sanitization", async () => {
  const folder = dir(), codec = encrypted();
  const cp = fileCheckpointer({ dir: folder, codec });
  await expect(cp.append("a/b", [event()])).rejects.toThrow(/session ids/);
  expect(() => fileTaskStore({ dir: folder, listId: "a/b", codec })).toThrow(/task-list ids/);
  expect(files(folder)).toEqual([]);
});


test.each(["task", "archive", "spill"] as const)("%s revalidates the destination after awaiting host encoding", async (kind) => {
  const folder = dir(), root = join(folder, "store");
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const base = encrypted(), codec: StorageCodec = { ...base, async encode(bytes, ctx) {
    started(); await gate; return base.encode(bytes, ctx);
  } };
  const pending = kind === "task" ? fileTaskStore({ dir: root, listId: "s", codec }).create({ subject: "test", description: "" })
    : kind === "archive" ? fileContextArchive({ dir: root, codec }).put("test")
    : fileSpillStore({ dir: root, codec }).put("test");
  await entered;
  const destination = kind === "task" ? join(root, "s") : root;
  renameSync(destination, `${destination}-old`);
  mkdirSync(destination);
  release();
  await expect(pending).rejects.toThrow(/directory changed/);
  expect(files(destination)).toEqual([]);
});
