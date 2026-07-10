import { expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const sandbox = vi.hoisted(() => ({
  initialize: vi.fn(async () => {}),
  wrap: vi.fn(async (command: string) => command),
  dispose: vi.fn(async () => {}),
}));

vi.mock("@lite-agent/sandbox-anthropic", () => ({
  sandboxRuntime: () => ({ id: "test-sandbox", ...sandbox }),
}));

vi.mock("../src/resources", async () => {
  const actual = await vi.importActual<typeof import("../src/resources")>("../src/resources");
  return {
    ...actual,
    resourceLimitedSandbox: (base: {
      id: string;
      initialize?: () => Promise<void> | void;
      wrap: (command: string, opts: { cwd: string }) => Promise<string> | string;
      dispose?: () => Promise<void> | void;
    }) => ({
      id: `resource-limited:${base.id}`,
      initialize: () => base.initialize?.(),
      wrap: (command: string, opts: { cwd: string }) => base.wrap(command, opts),
      dispose: () => base.dispose?.(),
    }),
  };
});

import { fakeProvider, textBlock } from "@lite-agent/core";
import { tool } from "@lite-agent/sdk";
import { createLocalAgent, isLoopbackEndpoint, localOpenAI, markLocalProvider } from "../src/index";
import type { EventSink } from "@lite-agent/sdk";

const localFake = (turns: Parameters<typeof fakeProvider>[0], nativeTools = true) => markLocalProvider(
  fakeProvider(turns),
  {
    endpoint: "http://127.0.0.1:9999/v1",
    nativeTools,
    contextWindow: 8192,
    runtime: "custom",
    tokenizerAccuracy: "approximate",
    probe: vi.fn(async () => {}),
  },
);

const memorySink = () => {
  const events: unknown[] = [];
  const sink: EventSink = {
    async write(sessionId, event) { events.push({ sessionId, event }); },
    async close() {},
  };
  return { sink, events };
};

test("strict local agent composes SQLite, audit, permissions, diagnostics, and lifecycle", async () => {
  const ran = { value: false };
  const probe = tool("probe", "probe", z.object({}), () => { ran.value = true; return "ok"; }, {
    security: { network: "none", filesystem: "none", sideEffects: "none" },
  });
  const provider = localFake([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "p1", name: "probe", input: {} }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const trace = memorySink();
  const agent = await createLocalAgent({
    model: provider,
    modelName: "local-test",
    workdir: mkdtempSync(join(tmpdir(), "local-agent-")),
    home: mkdtempSync(join(tmpdir(), "local-home-")),
    tools: [probe],
    permissionFiles: { user: false, project: false, inlineRules: [{ tool: "probe", effect: "allow" }] },
    eventSink: trace.sink,
    agents: false,
  });

  await agent.send("go");

  expect(ran.value).toBe(true);
  expect(await agent.queryAudit({ tool: "probe" })).toHaveLength(1);
  const exported = [];
  for await (const line of agent.exportAudit({ tool: "probe" })) exported.push(JSON.parse(line));
  expect(exported).toHaveLength(1);
  expect(agent.diagnostics()).toMatchObject({
    codec: "native",
    sandbox: { required: true, hardResourceLimits: true },
    persistence: { integrity: { ok: true } },
    trace: { enabled: true },
  });
  expect(trace.events.length).toBeGreaterThan(0);
  await agent.close();
  expect(sandbox.dispose).toHaveBeenCalled();
  await expect(agent.send("closed")).rejects.toThrow(/closed/);
});

test("auto codec selects JSON for a local model without native tools", async () => {
  const agent = await createLocalAgent({
    model: localFake([
      { text: "protocol", message: { role: "assistant", content: [textBlock('{"type":"final","text":"json answer"}')] } },
    ], false),
    modelName: "weak-local",
    workdir: mkdtempSync(join(tmpdir(), "local-json-")),
    home: mkdtempSync(join(tmpdir(), "local-home-")),
    eventSink: false,
    agents: false,
  });
  expect((await agent.send("go")).text).toBe("json answer");
  expect(agent.diagnostics().codec).toBe("json");
  await agent.close();
});

test("strict local mode rejects remote providers and undeclared custom tools", async () => {
  const remote = markLocalProvider(fakeProvider([]), {
    endpoint: "https://api.example.com/v1", nativeTools: true, contextWindow: 8192,
  });
  await expect(createLocalAgent({
    model: remote, modelName: "remote", workdir: process.cwd(), eventSink: false,
  })).rejects.toThrow(/loopback/);

  const unknown = tool("unknown", "unknown", z.object({}), () => "x");
  await expect(createLocalAgent({
    model: localFake([]), modelName: "local", workdir: process.cwd(), tools: [unknown],
    eventSink: false,
  })).rejects.toThrow(/missing security metadata/);
});

test("local OpenAI profiles expose loopback metadata without probing eagerly", () => {
  const provider = localOpenAI({ runtime: "ollama", contextWindow: 16384 });
  expect(provider.local).toMatchObject({
    endpoint: "http://127.0.0.1:11434/v1", nativeTools: false, contextWindow: 16384,
  });
  expect(isLoopbackEndpoint(provider.local.endpoint)).toBe(true);
  expect(isLoopbackEndpoint("http://10.0.0.2:8000/v1")).toBe(false);
  expect(isLoopbackEndpoint("http://127.example.com/v1")).toBe(false);
  expect(isLoopbackEndpoint("ftp://localhost/model")).toBe(false);
});

test("strict resource defaults pass platform probing on macOS/Linux", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const agent = await createLocalAgent({
    model: localFake([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]),
    modelName: "local",
    workdir: mkdtempSync(join(tmpdir(), "local-resources-")),
    home: mkdtempSync(join(tmpdir(), "local-home-")),
    eventSink: false,
    agents: false,
  });
  expect(agent.diagnostics().sandbox.hardResourceLimits).toBe(true);
  await agent.close();
});

test("local OpenAI health probe stays on the configured loopback endpoint", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
    status: 200, headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const provider = localOpenAI({ runtime: "vllm", contextWindow: 8192 });
    await provider.local.probe?.();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8000/v1/models", expect.any(Object));
  } finally {
    vi.unstubAllGlobals();
  }
});

test("close aborts an active tool before closing persistence and sandbox resources", async () => {
  let started!: () => void;
  const toolStarted = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  const waiting = tool("waiting", "waiting", z.object({}), async (_input, ctx) => {
    started();
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) { aborted = true; resolve(); return; }
      ctx.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    });
    return "stopped";
  }, { security: { network: "none", filesystem: "none", sideEffects: "none" } });
  const agent = await createLocalAgent({
    model: localFake([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "wait", name: "waiting", input: {} }] } },
    ]),
    modelName: "local-close",
    workdir: mkdtempSync(join(tmpdir(), "local-close-")),
    home: mkdtempSync(join(tmpdir(), "local-home-")),
    tools: [waiting],
    permissionFiles: { user: false, project: false, inlineRules: [{ tool: "waiting", effect: "allow" }] },
    eventSink: false,
    agents: false,
  });

  const pending = agent.send("wait");
  await toolStarted;
  await agent.close();
  await pending;
  expect(aborted).toBe(true);
});
