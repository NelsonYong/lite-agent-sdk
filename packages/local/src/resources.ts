import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Sandbox } from "@lite-agent/core";

export interface ResourceLimits {
  cpuSeconds: number;
  memoryBytes: number;
  maxProcesses: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  cpuSeconds: 120,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  maxProcesses: 128,
};

const BASH = "/bin/bash";
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export function probeResourceLimits(limits: ResourceLimits): void {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(`hard resource limits are unsupported on ${process.platform}`);
  if (!existsSync(BASH)) throw new Error("hard resource limits require /bin/bash");
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive safe integer`);
  }
  try {
    const memory = process.platform === "linux"
      ? `; ulimit -v ${Math.max(1, Math.floor(limits.memoryBytes / 1024))}`
      : "";
    execFileSync(BASH, ["-c", `ulimit -t ${limits.cpuSeconds}; ulimit -u ${limits.maxProcesses}${memory}`], {
      stdio: "ignore", timeout: 2000,
    });
    const rss = Number(execFileSync("ps", ["-o", "rss=", "-p", String(process.pid)], {
      encoding: "utf8", timeout: 2000,
    }).trim());
    if (!Number.isFinite(rss) || rss <= 0) throw new Error("process RSS probe returned no data");
  } catch (error) {
    throw new Error(`requested hard resource limits are unavailable: ${(error as Error).message}`);
  }
}

export function resourceLimitedSandbox(base: Sandbox, limits: ResourceLimits): Sandbox {
  const memory = process.platform === "linux"
    ? `; ulimit -v ${Math.max(1, Math.floor(limits.memoryBytes / 1024))}`
    : "";
  return {
    id: `resource-limited:${base.id}`,
    async initialize() {
      await base.initialize?.();
      probeResourceLimits(limits);
    },
    async wrap(command, opts) {
      const limited = `ulimit -t ${limits.cpuSeconds}; ulimit -u ${limits.maxProcesses}${memory}; exec /bin/sh -c ${quote(command)}`;
      return base.wrap(limited, opts);
    },
    dispose: () => base.dispose?.(),
  };
}
