import { expect, test } from "vitest";
import { DEFAULT_RESOURCE_LIMITS, probeResourceLimits, resourceLimitedSandbox } from "../src/resources";
import type { Sandbox } from "@lite-agent/core";

test("resourceLimitedSandbox prefixes hard limits before delegating", async () => {
  let seen = "";
  const base: Sandbox = {
    id: "base",
    wrap(command) { seen = command; return `wrapped:${command}`; },
  };
  const limited = resourceLimitedSandbox(base, {
    cpuSeconds: 10, memoryBytes: 1024 * 1024, maxProcesses: 7,
  });
  const output = await limited.wrap("echo 'hi'", { cwd: "/tmp" });
  expect(output).toContain("wrapped:ulimit -t 10");
  if (process.platform === "linux") expect(seen).toContain("ulimit -v 1024");
  else expect(seen).not.toContain("ulimit -v");
  expect(seen).toContain("ulimit -u 7");
  expect(seen).toContain("exec /bin/sh -c");
});

test("default resource limits are supported on macOS/Linux or fail explicitly elsewhere", () => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    expect(() => probeResourceLimits(DEFAULT_RESOURCE_LIMITS)).toThrow(/unsupported/);
    return;
  }
  try {
    probeResourceLimits(DEFAULT_RESOURCE_LIMITS);
  } catch (error) {
    // Supported kernels can still deny the capability inside a parent sandbox;
    // strict startup must surface that condition instead of degrading.
    expect((error as Error).message).toMatch(/requested hard resource limits are unavailable/);
  }
});
