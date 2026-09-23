import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { PermissionPolicy } from "@lite-agent/core";
import { resolveSafePath } from "../tools/file";

/** File rules always see a canonical, workspace-relative path. */
export function workspacePolicy(policy: PermissionPolicy, workdir: string): PermissionPolicy {
  return {
    check(call, ctx) {
      if (!["read_file", "write_file", "edit_file", "delete_file"].includes(call.name))
        return policy.check(call, ctx);
      const input = call.input as { path?: unknown } | null;
      if (typeof input?.path !== "string") return { decision: "deny", reason: "file path must be a string" };
      const root = realpathSync(resolve(workdir));
      const target = resolveSafePath(root, input.path, { mode: call.name === "read_file" ? "read" : "write" });
      const path = relative(root, target).split(sep).join("/");
      return policy.check({ ...call, input: { ...input, path } }, ctx);
    },
  };
}
