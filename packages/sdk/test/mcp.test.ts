import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { fakeProvider, policy, textBlock } from "@lite-agent/core";
import type { AgentEvent, ModelRequest, ModelProvider } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import type { LiteAgent } from "../src/liteAgent";

const agents: LiteAgent[] = [];
const dirs: string[] = [];
const handlers: ReturnType<typeof createMcpHandler>[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  await Promise.all(handlers.splice(0).map((handler) => handler.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.unstubAllGlobals();
});
function config() {
  const workdir = mkdtempSync(join(tmpdir(), "lite-mcp-")); dirs.push(workdir);
  return { workdir, home: join(workdir, "home"), cleanup: false, sessions: false, tasks: false, agents: false, hookFiles: false, context: false as const };
}
const reply = () => fakeProvider([{ message: { role: "assistant", content: [textBlock("ok")] } }]);
function agent(extra: Partial<Parameters<typeof createLiteAgent>[0]> = {}) {
  const a = createLiteAgent({ ...config(), model: reply(), ...extra }); agents.push(a); return a;
}
function serve(factory: () => McpServer) {
  const handler = createMcpHandler(factory, { legacy: "reject" }); handlers.push(handler);
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler.fetch(new Request(url, init)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function server(execute = vi.fn()) {
  const s = new McpServer({ name: "fixture", version: "1.0.0" });
  s.registerTool("echo", { inputSchema: fromJsonSchema({ type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }) }, async (input) => {
    const { value } = input as { value: string };
    execute(); return { content: [{ type: "text", text: String(value) }], structuredContent: value };
  });
  return s;
}
const http = { type: "http" as const, url: "https://fixture.invalid/mcp" };
const callModel = (name: string, input: unknown = { value: "hello" }) => fakeProvider([
  { message: { role: "assistant", content: [{ type: "tool_call", id: "call", name, input }] } },
  { message: { role: "assistant", content: [textBlock("done")] } },
]);

test("config discovery is lazy, merges identical entries and rejects conflicts without network", () => {
  const cfg = config(); mkdirSync(cfg.home); mkdirSync(join(cfg.workdir, ".lite-agent"));
  writeFileSync(join(cfg.home, "mcps.json"), JSON.stringify({ mcpServers: { docs: http } }));
  writeFileSync(join(cfg.workdir, ".lite-agent/mcps.json"), JSON.stringify({ mcpServers: { docs: http, other: http } }));
  const fetchMock = serve(() => server());
  const a = agent(cfg);
  expect(a.mcp.list().map(({ name, status }) => [name, status])).toEqual([["docs", "configured"], ["other", "configured"]]);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(agent({ ...cfg, strictMcpConfig: true }).mcp.list()).toEqual([]);
  expect(() => agent({ ...cfg, mcpServers: { docs: { ...http, url: "https://different.invalid/mcp" } } })).toThrow(/Conflicting/);
});

test("default permissions deny before connecting, and explicit transport restrictions apply to file and instance entries", async () => {
  const fetchMock = serve(() => server());
  const a = agent({ mcpServers: { docs: http } });
  await expect(a.send("go")).rejects.toThrow(/denied/);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(a.mcp.list()[0]?.status).toBe("error");
  expect(() => agent({ mcpTransports: ["stdio"], mcpServers: { docs: http } })).toThrow(/transport/);
  const restricted = agent({ mcpTransports: ["stdio"] });
  await expect(restricted.mcp.register("docs", http)).rejects.toThrow(/transport/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("instance registration discovers official modern tools; catalogs update on unregister, without leaking secrets", async () => {
  const requests: ModelRequest[] = [];
  const model: ModelProvider = { id: "capture", async *stream(req) { requests.push(req); yield { type: "message_done", message: { role: "assistant", content: [textBlock("ok")] }, usage: { inputTokens: 0, outputTokens: 0 } }; } };
  const fetchMock = serve(() => server());
  const a = agent({ model, permission: policy({ default: "allow" }) });
  await a.mcp.register("docs", { ...http, headers: { Authorization: "Bearer secret" } });
  expect(a.mcp.list()[0]).toMatchObject({ status: "ready", source: "instance", toolNames: ["mcp__docs__echo"] });
  expect(JSON.stringify(a.mcp.list())).not.toContain("secret");
  await expect(a.mcp.register("docs", http)).rejects.toThrow(/already/);
  await a.send("one");
  expect(requests[0]?.tools?.some((tool) => tool.name === "mcp__docs__echo")).toBe(true);
  const posts = await Promise.all(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(async ([url, init]) => ((await new Request(url, init).json()) as { method: string }).method));
  expect(posts).toContain("server/discover"); expect(posts).not.toContain("initialize");
  await a.mcp.unregister("docs"); await a.send("two");
  expect(requests[1]?.tools?.some((tool) => tool.name === "mcp__docs__echo")).toBe(false);
  await a.close(); await expect(a.mcp.register("later", http)).rejects.toThrow(/closed/);
});

test("MCP calls pass through permissions and hooks, preserve scalar structured content and validate input locally", async () => {
  const execute = vi.fn(); serve(() => server(execute));
  const a = agent({ model: callModel("mcp__docs__echo"), permission: policy({ default: "allow" }), mcpServers: { docs: http } });
  const events: AgentEvent[] = []; a.subscribe(({ event }) => events.push(event));
  const hook = vi.fn(); a.hook("tool:end", hook);
  await a.send("go");
  expect(execute).toHaveBeenCalledOnce();
  expect(events.find((event) => event.type === "tool_result")).toMatchObject({ result: { content: expect.stringContaining('"structuredContent":"hello"') } });
  expect(hook).toHaveBeenCalledOnce();
  const invalid = agent({ model: callModel("mcp__docs__echo", { value: 42 }), permission: policy({ default: "allow" }), mcpServers: { docs: http } });
  await invalid.send("go"); expect(execute).toHaveBeenCalledOnce();
  const denied = agent({ model: callModel("mcp__docs__echo"), permission: policy({ allow: ["mcp_connect"], deny: ["mcp__*"], default: "deny" }), mcpServers: { docs: http } });
  await denied.send("go"); expect(execute).toHaveBeenCalledOnce();
});

test("business failures stay errors and large results are archived rather than injected", async () => {
  serve(() => {
    const s = server();
    s.registerTool("failure", { inputSchema: fromJsonSchema({ type: "object" }) }, async () => ({ isError: true, content: [{ type: "text", text: "x".repeat(25_000) }], structuredContent: { reason: "failed" } }));
    return s;
  });
  const a = agent({ model: callModel("mcp__docs__failure", {}), permission: policy({ default: "allow" }), mcpServers: { docs: http } });
  const events: AgentEvent[] = []; a.subscribe(({ event }) => events.push(event));
  await a.send("go");
  const event = events.find((event) => event.type === "tool_result");
  expect(event).toMatchObject({ result: { isError: true, content: expect.stringContaining("archived:") } });
  if (event?.type === "tool_result") expect(event.result.content.length).toBeLessThan(1000);
});

test("progress is live, cancellation reaches the server and registry mutations reject during execution", async () => {
  let cancelled!: () => void;
  const serverCancelled = new Promise<void>((resolve) => { cancelled = resolve; });
  serve(() => {
    const s = server();
    s.registerTool("slow", { inputSchema: fromJsonSchema({ type: "object" }) }, async (_input, ctx) => {
      const signal = ctx.mcpReq.signal;
      const wait = new Promise<void>((resolve) => {
        if (signal.aborted) resolve(); else signal.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true });
      });
      await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: ctx.mcpReq._meta!.progressToken!, progress: 1, total: 2 } });
      await wait; return { content: [] };
    }); return s;
  });
  const a = agent({ model: callModel("mcp__docs__slow", {}), permission: policy({ default: "allow" }), mcpServers: { docs: http } });
  const controller = new AbortController();
  for await (const event of a.run("go", { signal: controller.signal })) {
    if (event.type === "tool_progress") {
      await expect(a.mcp.unregister("docs")).rejects.toThrow(/busy/);
      controller.abort();
    }
  }
  await serverCancelled;
  await a.mcp.unregister("docs");
});

test("failed registration is atomic, close is safe and invalid schemas never enter the catalog", async () => {
  serve(() => { const s = server(); s.server.setRequestHandler("tools/list", async () => ({ tools: [{ name: "bad", inputSchema: { type: "object", properties: { x: { $ref: "https://invalid.invalid/schema" } } } }], ttlMs: 0, cacheScope: "private" })); return s; });
  const a = agent({ permission: policy({ default: "allow" }) });
  await expect(a.mcp.register("bad", http)).rejects.toThrow(/discovery/);
  expect(a.mcp.list()).toEqual([]);
});

test("MCP namespace, plaintext remote URLs and malformed configuration are rejected", async () => {
  expect(() => agent({ mcpServers: { bad: { type: "http", url: "http://remote.invalid/mcp" } } })).toThrow(/HTTPS/);
  const a = agent();
  await expect(a.mcp.register("a__b", http)).rejects.toThrow(/name/);
  await expect(a.mcp.register("docs", { type: "http", url: "https://user:secret@example.com" })).rejects.toThrow(/credentials/);
  await expect(a.mcp.register("docs", { ...http, headers: { Host: "evil" } })).rejects.toThrow(/reserved/);
});

test("children borrow one connection and child close does not disconnect the parent", async () => {
  const execute = vi.fn(); const fetchMock = serve(() => server(execute));
  const parent = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "child", name: "Agent", input: { tasks: [{ display_name: "Worker", subagent_type: "general-purpose", prompt: "echo" }], run_in_background: false } }] } },
    { message: { role: "assistant", content: [{ type: "tool_call", id: "parent", name: "mcp__docs__echo", input: { value: "parent" } }] } },
    { message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const child = callModel("mcp__docs__echo");
  const model: ModelProvider = { id: "family", stream: (req, signal) => (req.system?.startsWith('You are the "') ? child : parent).stream(req, signal) };
  const a = agent({ model, agents: true, permission: policy({ default: "allow" }), mcpServers: { docs: http } });
  await a.send("go"); await a.awaitIdle();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(a.mcp.list()[0]?.status).toBe("ready");
  const bodies = fetchMock.mock.calls.map(([, init]) => typeof init?.body === "string" ? JSON.parse(init.body) as { method: string } : null);
  expect(bodies.filter((body) => body?.method === "server/discover")).toHaveLength(1);
});

test("close cancels a pending connection and denied stdio never invokes the sandbox", async () => {
  const wrap = vi.fn((command: string) => command);
  const denied = agent({ sandbox: { id: "test", wrap }, mcpServers: { local: { command: "node" } } });
  await expect(denied.send("go")).rejects.toThrow(/denied/); expect(wrap).not.toHaveBeenCalled();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    const signal = init.signal!;
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); started();
  }));
  const a = agent({ permission: policy({ default: "allow" }) });
  const registration = a.mcp.register("docs", http);
  const rejected = expect(registration).rejects.toThrow(/failed/);
  await ready; await a.close(); await rejected;
  expect(a.mcp.list()).toEqual([]);
});

test("tool allowlists filter MCP specs without reconnecting and hook mutations fail promptly", async () => {
  serve(() => server());
  let names: string[] = [];
  const model: ModelProvider = { id: "capture", async *stream(req) { names = req.tools?.map((tool) => tool.name) ?? []; yield { type: "message_done", message: { role: "assistant", content: [textBlock("ok")] }, usage: { inputTokens: 0, outputTokens: 0 } }; } };
  const a = agent({ model, permission: policy({ default: "allow" }), allowedTools: ["read_file"], mcpServers: { docs: http } });
  let reentrant: unknown;
  a.hook("run:start", async () => { try { await a.mcp.unregister("docs"); } catch (error) { reentrant = error; } });
  await a.send("go");
  expect(names).toEqual(["read_file"]); expect(reentrant).toBeInstanceOf(Error);
});

test("HTTP redirects are refused and response bytes are bounded before protocol parsing", async () => {
  const { mcpFetch } = await import("../src/mcp/http");
  const fetchMock = vi.fn(async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)));
  vi.stubGlobal("fetch", fetchMock);
  const response = await mcpFetch("https://fixture.invalid/mcp");
  await expect(response.text()).rejects.toThrow(/4 MiB/);
  expect(fetchMock).toHaveBeenCalledWith("https://fixture.invalid/mcp", expect.objectContaining({ redirect: "error" }));
});

test("server tool changes invalidate the catalog instead of replacing schemas during a run", async () => {
  serve(() => server());
  const a = agent({ permission: policy({ default: "allow" }) });
  await a.mcp.register("docs", http);
  handlers.at(-1)!.notify.toolsChanged();
  await vi.waitFor(() => expect(a.mcp.list()[0]?.status).toBe("stale"));
  await expect(a.send("go")).rejects.toThrow(/catalog unavailable/);
  await a.mcp.unregister("docs");
  await a.mcp.register("docs", http);
  expect(a.mcp.list()[0]?.status).toBe("ready");
});

test("cancelling a second session does not duplicate or discard shared initialization", async () => {
  let allow!: () => void;
  const gate = new Promise<void>((resolve) => { allow = resolve; });
  let requested!: () => void;
  const approvalStarted = new Promise<void>((resolve) => { requested = resolve; });
  const fetchMock = serve(() => server());
  const a = agent({ mcpServers: { docs: http }, onApproval: { async request() { requested(); await gate; return "allow"; } } });
  const first = a.send("one", { sessionId: "first" });
  await approvalStarted;
  const controller = new AbortController();
  const second = a.send("two", { sessionId: "second", signal: controller.signal });
  const cancelled = expect(second).rejects.toThrow(/aborted/);
  controller.abort(); await cancelled;
  expect(fetchMock).not.toHaveBeenCalled();
  allow(); await first;
  expect(a.mcp.list()[0]?.status).toBe("ready");
});

test("official output validation rejects malformed structured content without retrying the tool", async () => {
  const execute = vi.fn();
  serve(() => {
    const s = server();
    s.registerTool("output", { inputSchema: fromJsonSchema({ type: "object" }), outputSchema: fromJsonSchema({ type: "object", properties: { value: { type: "string" } }, required: ["value"] }) }, async () => ({ content: [], structuredContent: { value: "ok" } }));
    s.server.setRequestHandler("tools/call", async () => { execute(); return { content: [], structuredContent: { value: 42 } }; });
    return s;
  });
  const a = agent({ model: callModel("mcp__docs__output", {}), permission: policy({ default: "allow" }), mcpServers: { docs: http } });
  const events: AgentEvent[] = []; a.subscribe(({ event }) => events.push(event));
  await a.send("go");
  expect(execute).toHaveBeenCalledOnce();
  expect(events.find((event) => event.type === "tool_result")).toMatchObject({ result: { isError: true, content: expect.stringContaining("outcome may be unknown") } });
});
