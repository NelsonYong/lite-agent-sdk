import { expect, test } from "vitest";
import { AgentError, ProviderError, ToolError, CodecError, MaxTurnsError, AbortError } from "../src/events";

test("ProviderError carries status and is an AgentError", () => {
  const e = new ProviderError("upstream 503", 503);
  expect(e).toBeInstanceOf(AgentError);
  expect(e.name).toBe("ProviderError");
  expect(e.status).toBe(503);
});

test("error subclasses keep their own name", () => {
  expect(new ToolError("x").name).toBe("ToolError");
  expect(new CodecError("x").name).toBe("CodecError");
  expect(new MaxTurnsError("x").name).toBe("MaxTurnsError");
  expect(new AbortError().name).toBe("AbortError");
});
