import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { policy } from "@lite-agent/core";
import type {
  Condition, Decision, PermissionPolicy, PermissionRule, PolicyContext, PolicyVerdict, ToolCall,
} from "@lite-agent/core";

const conditionSchema: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ regex: z.string() }).strict(),
  z.object({ glob: z.string() }).strict(),
  z.object({ equals: z.unknown() }).strict(),
  z.object({ in: z.array(z.unknown()) }).strict(),
  z.object({ startsWith: z.string() }).strict(),
  z.object({ contains: z.string() }).strict(),
  z.object({ not: conditionSchema }).strict(),
]));

const ruleSchema = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  tool: z.union([z.string(), z.array(z.string())]).optional(),
  when: z.record(z.string(), conditionSchema).optional(),
  effect: z.enum(["allow", "deny", "ask"]),
}).strict();

const documentSchema = z.object({ version: z.literal(1), rules: z.array(ruleSchema) }).strict();

export interface PermissionFileOptions {
  workdir: string;
  home: string;
  managedFile?: string | false;
  userFile?: string | false;
  projectFile?: string | false;
  inlineRules?: PermissionRule[];
  baseRules?: PermissionRule[];
  default?: Decision;
  onReload?: (status: PermissionFileStatus) => void;
}

export interface PermissionFileStatus {
  files: string[];
  loadedAt: string;
  reloads: number;
  error?: string;
}

export interface FilePermissionPolicy extends PermissionPolicy {
  status(): PermissionFileStatus;
  reload(): void;
}

type Source = { layer: string; path: string };

export function permissionFilePolicy(opts: PermissionFileOptions): FilePermissionPolicy {
  const sources: Source[] = [];
  const managed = opts.managedFile === false
    ? undefined
    : opts.managedFile ?? process.env.LITE_AGENT_MANAGED_PERMISSIONS;
  if (managed) sources.push({ layer: "managed", path: resolve(managed) });
  if (opts.userFile !== false)
    sources.push({ layer: "user", path: resolve(opts.userFile ?? join(opts.home, "permissions.json")) });
  if (opts.projectFile !== false)
    sources.push({ layer: "project", path: resolve(opts.projectFile ?? join(opts.workdir, ".lite-agent", "permissions.json")) });

  let stamps = new Map<string, string>();
  let compiled: PermissionPolicy;
  let reloads = 0;
  let loadedAt = new Date(0).toISOString();
  let lastError: string | undefined;
  let loadedFiles: string[] = [];

  const stamp = (path: string): string => {
    if (!existsSync(path)) return "missing";
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  };
  const currentStamps = () => new Map(sources.map((source) => [source.path, stamp(source.path)]));
  const changed = () => {
    const current = currentStamps();
    if (current.size !== stamps.size) return true;
    for (const [path, value] of current) if (stamps.get(path) !== value) return true;
    return false;
  };
  const status = (): PermissionFileStatus => ({
    files: [...loadedFiles], loadedAt, reloads, ...(lastError ? { error: lastError } : {}),
  });
  const reload = () => {
    const rules: PermissionRule[] = [...(opts.baseRules ?? [])];
    const files: string[] = [];
    try {
      for (const source of sources) {
        if (!existsSync(source.path)) continue;
        const doc = documentSchema.parse(JSON.parse(readFileSync(source.path, "utf8")));
        files.push(source.path);
        rules.push(...doc.rules.map((rule, index): PermissionRule => ({
          ...rule,
          id: `${source.layer}:${rule.id ?? index}`,
          description: rule.description ?? `${source.layer} permission rule`,
        })));
      }
      rules.push(...(opts.inlineRules ?? []).map((rule, index) => ({
        ...rule,
        id: `inline:${rule.id ?? index}`,
      })));
      compiled = policy({ rules, default: opts.default ?? "deny" });
      stamps = currentStamps();
      loadedFiles = files;
      loadedAt = new Date().toISOString();
      lastError = undefined;
      reloads++;
      opts.onReload?.(status());
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      opts.onReload?.(status());
      throw new Error(`Invalid permission configuration: ${lastError}`);
    }
  };

  reload();
  return {
    async check(call: ToolCall, ctx: PolicyContext): Promise<Decision | PolicyVerdict> {
      if (changed()) reload();
      return compiled.check(call, ctx);
    },
    status,
    reload,
  };
}
