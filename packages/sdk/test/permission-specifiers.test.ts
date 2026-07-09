import { expect, test } from "vitest";
import { policy } from "@lite-agent/core";
import { bashCommand, filePath } from "../src/permission/specifiers";

test("bashCommand: ':*' becomes a command prefix rule", () => {
  const p = policy({
    rules: [bashCommand("npm run test:*", "allow"), bashCommand("rm -rf", "deny")],
  });

  expect(
    p.check(
      { id: "1", name: "bash", input: { command: "npm run test:unit" } },
      { sessionId: "s" },
    ),
  ).toMatchObject({ decision: "allow" });
  expect(
    p.check(
      { id: "1", name: "bash", input: { command: "rm -rf /" } },
      { sessionId: "s" },
    ),
  ).toMatchObject({ decision: "deny" });
  expect(
    p.check(
      { id: "1", name: "bash", input: { command: "ls" } },
      { sessionId: "s" },
    ),
  ).toBe("allow");
});

test("filePath: gates the file tools by a path glob", () => {
  const p = policy({ default: "deny", rules: [filePath("src/**", "allow")] });

  expect(
    p.check(
      { id: "1", name: "write_file", input: { path: "src/a.ts" } },
      { sessionId: "s" },
    ),
  ).toMatchObject({ decision: "allow" });
  expect(
    p.check(
      { id: "1", name: "write_file", input: { path: "secrets/a" } },
      { sessionId: "s" },
    ),
  ).toBe("deny");
});
