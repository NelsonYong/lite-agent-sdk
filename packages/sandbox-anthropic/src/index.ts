import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { Sandbox } from "@lite-agent/core";

export interface SandboxRuntimeOptions {
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowWrite?: string[];
  denyRead?: string[];
  denyWrite?: string[];
}

export function sandboxRuntime(opts: SandboxRuntimeOptions = {}): Sandbox {
  const config: SandboxRuntimeConfig = {
    network: { allowedDomains: opts.allowedDomains ?? [], deniedDomains: opts.deniedDomains ?? [] },
    filesystem: {
      allowWrite: opts.allowWrite ?? ["."],
      denyRead: opts.denyRead ?? ["~/.ssh", "~/.aws"],
      denyWrite: opts.denyWrite ?? [],
    },
  };
  let ready: Promise<void> | undefined;
  return {
    id: "sandbox-runtime",
    async wrap(command) {
      ready ??= SandboxManager.initialize(config);
      await ready;
      return SandboxManager.wrapWithSandbox(command);
    },
    dispose: () => SandboxManager.reset(),
  };
}
