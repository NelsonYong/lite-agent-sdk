import { expect, test } from "vitest";
import { AgentError, ProviderError, ToolError, CodecError, MaxTurnsError, AbortError } from "../src/events";
import type { AgentEvent } from "../src/events";

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

test("AgentEvent carries an optional agentId for source attribution", () => {
  const e: AgentEvent = { type: "text_delta", text: "hi", agentId: "agent-x" };
  expect(e.agentId).toBe("agent-x");
  const plain: AgentEvent = { type: "text_delta", text: "hi" };
  expect(plain.agentId).toBeUndefined();
});
