import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { PermissionPolicy } from "@lite-agent/core";
import { resolveReadPath, resolveSafePath } from "../tools/file";

/** File rules always see a canonical, workspace-relative path. */
export function workspacePolicy(policy: PermissionPolicy, workdir: string, readRoots?: (sessionId: string) => readonly string[]): PermissionPolicy {
  return {
    check(call, ctx) {
      if (!["read_file", "write_file", "edit_file", "delete_file"].includes(call.name))
        return policy.check(call, ctx);
      const input = call.input as { path?: unknown } | null;
      if (typeof input?.path !== "string") return { decision: "deny", reason: "file path must be a string" };
      const root = realpathSync(resolve(workdir));
      const target = call.name === "read_file" ? resolveReadPath(root, input.path, readRoots?.(ctx.sessionId))
        : resolveSafePath(root, input.path, { mode: "write" });
      const rel = relative(root, target);
      const path = (rel === ".." || rel.startsWith(`..${sep}`) ? target : rel).split(sep).join("/");
      return policy.check({ ...call, input: { ...input, path } }, ctx);
    },
  };
}
