import { expect, test } from "vitest";
import { z } from "zod";
import { defineTool, toToolSpec } from "../src/tools/define";

const echo = defineTool({
  name: "echo",
  description: "Echo a message back",
  schema: z.object({ msg: z.string() }),
  execute: (input) => input.msg,
});

test("defineTool returns the tool unchanged with typed execute", () => {
  expect(echo.name).toBe("echo");
  expect(echo.execute({ msg: "hi" }, {} as never)).toBe("hi");
});

test("toToolSpec derives a JSON-schema parameters object from zod", () => {
  const spec = toToolSpec(echo);
  expect(spec.name).toBe("echo");
  expect(spec.description).toBe("Echo a message back");
  expect(spec.parameters).toMatchObject({
    type: "object",
    properties: { msg: { type: "string" } },
    required: ["msg"],
  });
});

test("tool schema rejects bad input", () => {
  expect(() => echo.schema.parse({ msg: 123 })).toThrow();
});
