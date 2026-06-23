import type { Store } from "./strategies";
import type { Message } from "./types";

// In-memory Store — the trivial default, mirroring noopSandbox(). Snapshots on
// save so the caller's later mutations of the message array don't leak in.
export function memoryStore(): Store {
  const sessions = new Map<string, Message[]>();
  return {
    async load(id) {
      return sessions.get(id) ?? null;
    },
    async save(id, messages) {
      sessions.set(id, structuredClone(messages));
    },
  };
}
