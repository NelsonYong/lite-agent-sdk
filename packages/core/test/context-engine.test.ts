import { expect, test, vi } from "vitest";
import { memoryCheckpointer } from "../src/checkpoint";
import { CheckpointConflictError } from "../src/events";
import { ContextEngine, type ContextArchive, type ContextPlanner } from "../src/contextEngine";
import { textBlock, toolResultBlock, type Message, type ModelRequest } from "../src/types";

const user = (content: string) => ({ type: "user" as const, message: { role: "user" as const, content } });
const assistant = (text: string) => ({
  type: "assistant" as const,
  message: { role: "assistant" as const, content: [textBlock(text)] },
});

const toolCall = (id = "call-1") => ({
  type: "assistant" as const,
  message: {
    role: "assistant" as const,
    content: [{ type: "tool_call" as const, id, name: "read_file", input: { path: "a.txt" } }],
  },
});

const request = (messages: Message[]): ModelRequest => ({
  model: "test",
  system: "stable system",
  messages,
});

test("serializes concurrent appends and keeps the checkpointer head linear", async () => {
  const cp = memoryCheckpointer();
  const engine = new ContextEngine({ sessionId: "serial", checkpointer: cp, staticPrefix: { system: "stable" } });

  await Promise.all([
    engine.append([user("one")]),
    engine.append([user("two")]),
    engine.append([user("three")]),
  ]);

  const events = [];
  for await (const entry of cp.read("serial")) events.push(entry.event);
  expect(events).toHaveLength(3);
  expect(await cp.head("serial")).toBe(3);
});

test("snapshot returns an immutable copy", async () => {
  const engine = new ContextEngine({ sessionId: "immutable", staticPrefix: { system: "stable" } });
  await engine.append([user("Goal: keep this fact")]);

  const first = await engine.snapshot();
  expect(() => (first.messages as Message[]).push({ role: "user", content: "mutated" })).toThrow(TypeError);
  expect(() => { (first.facts as unknown as Array<{ text: string }>)[0]!.text = "mutated"; }).toThrow(TypeError);

  const second = await engine.snapshot();
  expect(second.messages.map((m) => m.content)).not.toContain("mutated");
  expect(second.facts[0]?.text).toBe("Goal: keep this fact");
  expect(Object.isFrozen(second)).toBe(true);
});

test("asserts a stale head before asking the provider to count tokens", async () => {
  const cp = memoryCheckpointer();
  const countTokens = vi.fn(async () => 10);
  const engine = new ContextEngine({
    sessionId: "stale",
    checkpointer: cp,
    provider: { id: "counting", stream: async function* () {}, context: { countTokens } },
    staticPrefix: { system: "stable" },
    windowTokens: 100,
  });
  await engine.append([user("first")]);
  await cp.append("stale", [user("external")]);

  await expect(engine.prepare(request([]))).rejects.toBeInstanceOf(CheckpointConflictError);
  expect(countTokens).not.toHaveBeenCalled();
});

test("level one externalizes only tool results that were presented", async () => {
  const archive: ContextArchive = {
    put: vi.fn((content: string) => ({ ref: `archive:${content.length}`, preview: content.slice(0, 20) })),
  };
  const engine = new ContextEngine({
    sessionId: "presentation",
    staticPrefix: { system: "stable" },
    archive,
    windowTokens: 8,
  });
  await engine.append([
    user("Goal: inspect a file"),
    toolCall(),
    { type: "tool_result", result: toolResultBlock("call-1", "very large tool output ".repeat(40)), turn: 1 },
  ]);

  const beforePresentation = await engine.compact("pressure");
  expect(archive.put).not.toHaveBeenCalled();
  expect(beforePresentation.archiveRefs).toEqual([]);

  const presented = await engine.snapshot();
  await engine.presented(presented.generation);
  const afterPresentation = await engine.compact("pressure");
  expect(archive.put).toHaveBeenCalledTimes(1);
  expect(afterPresentation.archiveRefs).toHaveLength(1);
});

test("normalization keeps semantic user and assistant turns", async () => {
  const engine = new ContextEngine({ sessionId: "semantic", staticPrefix: { system: "stable" }, windowTokens: 12 });
  await engine.append([
    user("Goal: ship the feature"),
    assistant("v1 failed"),
    user("retry with a smaller patch"),
    assistant("v2 failed"),
    user("run the verified path"),
    assistant("v3 succeeded"),
  ]);

  const view = await engine.compact("normalize");
  const text = JSON.stringify(view.messages);
  expect(text).toContain("Goal: ship the feature");
  expect(text).toContain("v1 failed");
  expect(text).toContain("v2 failed");
  expect(text).toContain("v3 succeeded");
});

test("planner timeout falls back to deterministic projection", async () => {
  const planner: ContextPlanner = {
    async propose() {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { segments: [], stateDelta: {} };
    },
  };
  const engine = new ContextEngine({
    sessionId: "planner-timeout",
    staticPrefix: { system: "stable" },
    planner,
    windowTokens: 4,
  });
  await engine.append([user("Goal: preserve this"), assistant("old answer ".repeat(100))]);

  const started = Date.now();
  const view = await engine.compact("planner");
  expect(Date.now() - started).toBeLessThan(300);
  expect(view.facts[0]?.text).toBe("Goal: preserve this");
});

test("planner can summarize superseded failed attempts while keeping the active segment", async () => {
  const planner: ContextPlanner = {
    async propose(input) {
      return {
        segments: input.candidates
          .filter((segment) => JSON.stringify(segment.messages).includes("failed"))
          .map((segment) => ({
            id: segment.id,
            action: "summarize" as const,
            classification: "superseded" as const,
            summary: "Earlier attempt failed; do not repeat it.",
          })),
      };
    },
  };
  const engine = new ContextEngine({
    sessionId: "planner-selection",
    staticPrefix: { system: "stable" },
    planner,
    windowTokens: 8,
  });
  await engine.append([
    user("Goal: ship the feature"),
    assistant("v1 failed"),
    user("retry"),
    assistant("v2 failed"),
    user("verified path"),
    assistant("v3 succeeded"),
  ]);

  const view = await engine.compact("planner");
  const text = JSON.stringify(view.messages);
  expect(text).toContain("Earlier attempt failed; do not repeat it.");
  expect(text).not.toContain("v1 failed");
  expect(text).not.toContain("v2 failed");
  expect(text).toContain("v3 succeeded");
});

test("level four preserves the active segment verbatim while shrinking older transcript", async () => {
  const old = "old attempt ".repeat(300);
  const active = "current implementation details ".repeat(300);
  const engine = new ContextEngine({ sessionId: "active-tail", staticPrefix: { system: "stable" }, windowTokens: 16 });
  await engine.append([
    user("Goal: keep the active work"),
    assistant(old),
    user("continue with the verified path"),
    assistant(active),
  ]);

  const view = await engine.compact("manual");
  const text = JSON.stringify(view.messages);
  expect(text).toContain(active);
  expect(text).not.toContain(old);
});

test("emergency level five strictly reduces the rendered tail without dropping current input", async () => {
  const engine = new ContextEngine({ sessionId: "emergency", staticPrefix: { system: "stable" }, windowTokens: 20 });
  await engine.append([
    user("Goal: retain the objective"),
    assistant("old transcript ".repeat(500)),
  ]);
  const input = { role: "user" as const, content: "current request must remain verbatim" };
  const before = await engine.snapshot();
  const prepared = await engine.prepare(request([input]), [input]);

  expect(JSON.stringify(prepared.messages).length).toBeLessThan(JSON.stringify(before.messages).length + 200);
  expect(prepared.messages.at(-1)).toEqual(input);
});

test("a committed context view restores with a later raw tail", async () => {
  const cp = memoryCheckpointer();
  const first = new ContextEngine({ sessionId: "restore", checkpointer: cp, staticPrefix: { system: "stable" } });
  await first.append([user("Goal: restore facts"), assistant("old")]);
  await first.compact("manual");
  await first.append([user("later tail")]);

  const second = new ContextEngine({ sessionId: "restore", checkpointer: cp, staticPrefix: { system: "stable" } });
  const restored = await second.snapshot();
  expect(restored.facts[0]?.text).toBe("Goal: restore facts");
  expect(restored.messages.at(-1)).toEqual({ role: "user", content: "later tail" });
});
