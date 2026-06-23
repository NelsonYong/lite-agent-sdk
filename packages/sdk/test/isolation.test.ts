import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

test("the suite runs with an isolated LITE_AGENT_HOME under tmpdir", () => {
  const home = process.env.LITE_AGENT_HOME;
  expect(home).toBeTruthy();
  expect(home!.startsWith(tmpdir())).toBe(true);
  expect(existsSync(home!)).toBe(true);
});
