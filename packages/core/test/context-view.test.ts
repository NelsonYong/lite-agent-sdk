import { expect, test } from "vitest";
import { foldEvents } from "../src/checkpoint";
import type { SessionEvent, StoredEvent } from "../src/checkpoint";
import {
  projectContext,
  type ContextView,
  type StaticPrefixInput,
} from "../src/context";
import { textBlock, toolResultBlock } from "../src/types";

const stored = (seq: number, event: SessionEvent): StoredEvent => ({
  seq,
  sessionId: "session",
  parentSeq: seq === 1 ? null : seq - 1,
  ts: `2026-07-17T00:00:${String(seq).padStart(2, "0")}.000Z`,
  event,
});

test("projects complete turns with tool pairing and event provenance", () => {
  const events: StoredEvent[] = [
    stored(1, { type: "user", message: { role: "user", content: "Goal: inspect the cache" } }),
    stored(2, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_call", id: "read-1", name: "read_file", input: { path: "cache.ts" } }],
      },
    }),
    stored(3, { type: "tool_started", id: "read-1", name: "read_file", turn: 1 }),
    stored(4, { type: "tool_result", result: toolResultBlock("read-1", "cache contents"), turn: 1 }),
    stored(5, { type: "assistant", message: { role: "assistant", content: [textBlock("done")] } }),
  ];

  const view = projectContext(events);

  expect(view.messages).toEqual([
    { role: "user", content: "Goal: inspect the cache" },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "read-1", name: "read_file", input: { path: "cache.ts" } }],
    },
    { role: "user", content: [toolResultBlock("read-1", "cache contents")] },
    { role: "assistant", content: [textBlock("done")] },
  ]);
  expect(view.segments).toHaveLength(1);
  expect(view.segments[0]).toMatchObject({
    eventRange: [1, 5],
    sourceSeqs: [1, 2, 3, 4, 5],
  });
  expect(view.segments[0]!.messages).toEqual(view.messages);
  expect(view.facts).toContainEqual({
    id: "session:1:goal",
    kind: "goal",
    text: "Goal: inspect the cache",
    evidenceRefs: ["session:1"],
  });
});

test("restores a committed context view and appends only its later raw tail", () => {
  const compressed: ContextView = {
    generation: 2,
    facts: [],
    workingState: [{ key: "next", value: "run tests", evidenceRefs: ["session:2"] }],
    segments: [{
      id: "session:1-2",
      eventRange: [1, 2],
      sourceSeqs: [1, 2],
      messageRange: [0, 1],
      messages: [{ role: "user", content: "Earlier work was compressed." }],
    }],
    archiveRefs: ["archive:old"],
    messages: [{ role: "user", content: "Earlier work was compressed." }],
    prefixFingerprint: "previous-prefix",
  };
  const events: StoredEvent[] = [
    stored(1, { type: "user", message: { role: "user", content: "Goal: preserve the source of truth" } }),
    stored(2, { type: "assistant", message: { role: "assistant", content: [textBlock("old answer")] } }),
    stored(3, { type: "context_view", throughSeq: 2, view: compressed }),
    stored(4, { type: "user", message: { role: "user", content: "Constraint: keep the later tail" } }),
  ];

  expect(foldEvents(events.map(({ event }) => event))).toEqual([
    { role: "user", content: "Goal: preserve the source of truth" },
    { role: "assistant", content: [textBlock("old answer")] },
    { role: "user", content: "Constraint: keep the later tail" },
  ]);

  const view = projectContext(events);
  expect(view.messages).toEqual([
    { role: "user", content: "Earlier work was compressed." },
    { role: "user", content: "Constraint: keep the later tail" },
  ]);
  expect(view.generation).toBe(2);
  expect(view.workingState).toEqual(compressed.workingState);
  expect(view.archiveRefs).toEqual(["archive:old"]);
});

test("rebuilds verbatim fact pins from all raw events after a derived summary", () => {
  const events: StoredEvent[] = [
    stored(1, { type: "user", message: { role: "user", content: "Goal: retain the exact user goal" } }),
    stored(2, { type: "user", message: { role: "user", content: "Constraint: never compact the static prefix" } }),
    stored(3, {
      type: "artifact_verified",
      path: "src/context.ts",
      revision: "sha256:abc",
      command: "pnpm test",
      result: "passed",
      turn: 1,
    }),
    stored(4, {
      type: "context_view",
      throughSeq: 3,
      view: {
        generation: 1,
        facts: [],
        workingState: [],
        segments: [],
        archiveRefs: [],
        messages: [{ role: "user", content: "A lossy derived summary." }],
        prefixFingerprint: "stale",
      },
    }),
  ];

  expect(projectContext(events).facts).toEqual([
    {
      id: "session:1:goal",
      kind: "goal",
      text: "Goal: retain the exact user goal",
      evidenceRefs: ["session:1"],
    },
    {
      id: "session:2:constraint",
      kind: "constraint",
      text: "Constraint: never compact the static prefix",
      evidenceRefs: ["session:2"],
    },
    {
      id: "session:3:artifact",
      kind: "artifact",
      text: "src/context.ts",
      path: "src/context.ts",
      revision: "sha256:abc",
      verification: { command: "pnpm test", result: "passed" },
      evidenceRefs: ["session:3"],
    },
  ]);
});

test("fingerprints only canonical static-prefix input", () => {
  const staticPrefix: StaticPrefixInput = {
    system: "stable system",
    tools: [{ name: "read", description: "Read", parameters: { required: ["path"], type: "object" } }],
    codec: { protocol: "native-v1", id: "native" },
  };
  const first = projectContext([
    stored(1, { type: "user", message: { role: "user", content: "first dynamic message" } }),
  ], { staticPrefix });
  const second = projectContext([
    stored(1, { type: "user", message: { role: "user", content: "different dynamic message" } }),
  ], {
    staticPrefix: {
      system: "stable system",
      tools: [{ name: "read", description: "Read", parameters: { type: "object", required: ["path"] } }],
      codec: { id: "native", protocol: "native-v1" },
    },
  });
  const changed = projectContext([], {
    staticPrefix: { ...staticPrefix, system: "changed system" },
  });

  expect(first.prefixFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(second.prefixFingerprint).toBe(first.prefixFingerprint);
  expect(changed.prefixFingerprint).not.toBe(first.prefixFingerprint);
});
