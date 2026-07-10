import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { Sandbox } from "@lite-agent/core";

export interface SandboxRuntimeOptions {
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowWrite?: string[];
  allowRead?: string[];
  denyRead?: string[];
  denyWrite?: string[];
  allowLocalBinding?: boolean;
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  enableWeakerNestedSandbox?: boolean;
  enableWeakerNetworkIsolation?: boolean;
  allowAppleEvents?: boolean;
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
      allowLocalBinding: opts.allowLocalBinding ?? false,
      allowUnixSockets: opts.allowUnixSockets ?? [],
      allowAllUnixSockets: opts.allowAllUnixSockets ?? false,
    },
    filesystem: {
      allowWrite: opts.allowWrite ?? ["."],
      allowRead: opts.allowRead ?? [],
      denyRead: opts.denyRead ?? ["~/.ssh", "~/.aws"],
      denyWrite: opts.denyWrite ?? [],
    },
    enableWeakerNestedSandbox: opts.enableWeakerNestedSandbox ?? false,
    enableWeakerNetworkIsolation: opts.enableWeakerNetworkIsolation ?? false,
    allowAppleEvents: opts.allowAppleEvents ?? false,
  };
  let ready: Promise<void> | undefined;
  let degraded = false;
  const initialize = async (): Promise<void> => {
    if (degraded) return;
    try {
      ready ??= SandboxManager.initialize(config);
      await ready;
    } catch (err) {
      if (opts.requireSandbox) throw err;
      degraded = true;
      opts.onUnavailable?.(err as Error);
    }
  };
  return {
    id: "sandbox-runtime",
    initialize,
    async wrap(command) {
      if (degraded) return command;
      await initialize();
      if (degraded) return command;
      return SandboxManager.wrapWithSandbox(command);
    },
    dispose: async () => {
      if (ready && !degraded) await SandboxManager.reset();
    },
  };
}
