import type { TaskStore } from "./types";

export type TaskStoreSource = TaskStore | ((sessionId: string) => TaskStore);

export function taskStoreFor(source: TaskStoreSource, sessionId: string): TaskStore {
  return typeof source === "function" ? source(sessionId) : source;
}
