import { expect, test } from "vitest";
import { z } from "zod";
import { fakeProvider, textBlock } from "@lite-agent/core";
import { query } from "../src/query";
import { tool } from "../src/tool";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectPaths } from "../src/paths";

test("query() streams events and returns a result", async () => {
  const fp = fakeProvider([
    {
      text: "hi there",
      message: { role: "assistant", content: [textBlock("hi there")] },
    },
  ]);
  const types: string[] = [];
  const gen = query({ prompt: "hi", model: fp, cwd: process.cwd() });
  let r = await gen.next();
  while (!r.done) {
    types.push(r.value.type);
    r = await gen.next();
  }
  expect(types).toContain("done");
  expect(r.value.text).toBe("hi there");
});

test("tool() builds a working Tool", async () => {
  const t = tool(
    "double",
    "double a number",
    z.object({ n: z.number() }),
    ({ n }) => String(n * 2),
  );
  expect(t.name).toBe("double");
  const ctx = {
    sessionId: "s",
    signal: new AbortController().signal,
    emit: () => {},
  };
  expect(await t.execute({ n: 3 }, ctx)).toBe("6");
});

test("query forwards sessions:false (no transcript written)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "q-wd-"));
  const gen = query({
    prompt: "hi",
    model: fakeProvider([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]),
    cwd,
    sessionId: "qs1",
    sessions: false,
  });
  // drive the generator to completion
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  const { sessionsDir } = resolveProjectPaths({ workdir: cwd, home: process.env.LITE_AGENT_HOME! });
  expect(existsSync(join(sessionsDir, "qs1.jsonl"))).toBe(false);
});
