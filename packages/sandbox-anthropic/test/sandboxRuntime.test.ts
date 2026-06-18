import { expect, test, vi } from "vitest";

const { initialize, wrapWithSandbox, reset } = vi.hoisted(() => ({
  initialize: vi.fn(async (_config: unknown) => {}),
  wrapWithSandbox: vi.fn(async (cmd: string) => `SBX(${cmd})`),
  reset: vi.fn(async () => {}),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: { initialize, wrapWithSandbox, reset },
}));

import { sandboxRuntime } from "../src/index";

test("maps options, lazily initializes once, and wraps commands", async () => {
  const sb = sandboxRuntime({ allowedDomains: ["api.github.com"], denyRead: ["~/.ssh"], denyWrite: [".env"] });
  expect(sb.id).toBe("sandbox-runtime");

  expect(await sb.wrap("echo one", { cwd: "/w" })).toBe("SBX(echo one)");
  await sb.wrap("echo two", { cwd: "/w" });

  expect(initialize).toHaveBeenCalledTimes(1);
  expect(initialize.mock.calls[0]![0]).toMatchObject({
    network: { allowedDomains: ["api.github.com"], deniedDomains: [] },
    filesystem: { allowWrite: ["."], denyRead: ["~/.ssh"], denyWrite: [".env"] },
  });
  expect(wrapWithSandbox).toHaveBeenCalledTimes(2);

  await sb.dispose?.();
  expect(reset).toHaveBeenCalledTimes(1);
});

test("defaults: empty network, cwd-only write, sensible denyRead", async () => {
  const sb = sandboxRuntime();
  await sb.wrap("echo hi", { cwd: "/w" });
  expect(initialize.mock.calls.at(-1)![0]).toMatchObject({
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { allowWrite: ["."], denyRead: ["~/.ssh", "~/.aws"] },
  });
});
