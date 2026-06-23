import { expect, test } from "vitest";
import { z } from "zod";
import { fakeProvider, textBlock } from "@lite-agent/core";
import { query } from "../src/query";
import { tool } from "../src/tool";

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
