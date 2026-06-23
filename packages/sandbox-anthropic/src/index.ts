import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { Sandbox } from "@lite-agent/core";

export interface SandboxRuntimeOptions {
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowWrite?: string[];
  denyRead?: string[];
  denyWrite?: string[];
  /** If the OS sandbox can't initialize (no bubblewrap, native Windows, …): false (default) → degrade to noop; true → throw. */
  requireSandbox?: boolean;
  /** Called once when degrading to noop (requireSandbox=false and init failed). */
  onUnavailable?: (err: Error) => void;
}

export function sandboxRuntime(opts: SandboxRuntimeOptions = {}): Sandbox {
  const config: SandboxRuntimeConfig = {
    network: {
      allowedDomains: opts.allowedDomains ?? [],
      deniedDomains: opts.deniedDomains ?? [],
    },
    filesystem: {
      allowWrite: opts.allowWrite ?? ["."],
      denyRead: opts.denyRead ?? ["~/.ssh", "~/.aws"],
      denyWrite: opts.denyWrite ?? [],
    },
  };
  let ready: Promise<void> | undefined;
  let degraded = false;
  return {
    id: "sandbox-runtime",
    async wrap(command) {
      if (degraded) return command;
      try {
        ready ??= SandboxManager.initialize(config);
        await ready;
      } catch (err) {
        if (opts.requireSandbox) throw err;
        degraded = true;
        opts.onUnavailable?.(err as Error);
        return command;
      }
      return SandboxManager.wrapWithSandbox(command);
    },
    dispose: async () => {
      if (ready && !degraded) await SandboxManager.reset();
    },
  };
}
