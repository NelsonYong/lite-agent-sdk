import type { Decision, PermissionRule } from "@lite-agent/core";

/** `bashCommand("npm run test:*", "deny")` uses `:*` as a prefix match; otherwise contains. */
export function bashCommand(spec: string, effect: Decision): PermissionRule {
  const prefix = spec.endsWith(":*");
  const value = prefix ? spec.slice(0, -2) : spec;
  return {
    description: `bash ${spec}`,
    tool: "bash",
    when: { command: prefix ? { startsWith: value } : { contains: value } },
    effect,
  };
}

/** Gate the file tools by a path glob, for example `filePath("src/**", "allow")`. */
export function filePath(glob: string, effect: Decision): PermissionRule {
  return {
    description: `path ${glob}`,
    tool: ["read_file", "write_file", "edit_file"],
    when: { path: { glob } },
    effect,
  };
}
