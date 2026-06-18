import type { Sandbox } from "./strategies";

// Default boundary: none. Returns the command unchanged so behavior matches a
// world without a sandbox — keeps the core lean and cross-platform.
export function noopSandbox(): Sandbox {
  return { id: "noop", wrap: (command) => command };
}
