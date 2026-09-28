import { homedir } from "node:os";
import { resolve, join } from "node:path";
import type { AgentStorage } from "./storage";
import { createHash } from "node:crypto";

/** Global home. Only the default namespace inherits `$LITE_AGENT_HOME`. */
export function liteAgentHome(namespace = "lite-agent"): string {
  validateNamespace(namespace);
  return (namespace === "lite-agent" ? process.env.LITE_AGENT_HOME : undefined) || join(homedir(), `.${namespace}`);
}

function validateNamespace(namespace: string): void {
  if (typeof namespace !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(namespace))
    throw new Error("storage.namespace must be 1-64 lowercase letters, digits, underscores or hyphens, starting with a letter");
}

/** Stable per absolute project path: first 16 hex of sha1(resolve(workdir)). */
export function projectHash(workdir: string): string {
  return createHash("sha1").update(resolve(workdir)).digest("hex").slice(0, 16);
}

export interface ProjectPaths {
  home: string;
  namespace: string;
  projectConfigDir: string;
  hash: string;
  spillDir: string;
  sessionsDir: string;
  tasksDir: string;
  globalSkillsDir: string;
  projectSkillsDir: string;
  globalAgentsDir: string;
  projectAgentsDir: string;
}

/** Session-local derived context sidecar: never shared across projects/sessions. */
export function sessionContextDir(sessionsDir: string, sessionId: string): string {
  const safe = /^[a-zA-Z0-9_-]+$/.test(sessionId) ? sessionId : `session-${createHash("sha256").update(sessionId).digest("hex")}`;
  return join(sessionsDir, `${safe}.context`);
}

/** Pure: derive every path from `workdir` (+ optional home). No fs side effects. */
export function resolveProjectPaths(opts: { workdir: string; home?: string; storage?: AgentStorage }): ProjectPaths {
  const namespace = opts.storage?.namespace ?? "lite-agent";
  validateNamespace(namespace);
  if (opts.home !== undefined && opts.storage?.home !== undefined && resolve(opts.home) !== resolve(opts.storage.home))
    throw new Error("home and storage.home conflict; use storage.home");
  if (opts.storage?.home !== undefined && !opts.storage.home.trim()) throw new Error("storage.home must not be empty");
  const home = resolve(opts.storage?.home ?? opts.home ?? liteAgentHome(namespace));
  const projectConfigDir = join(resolve(opts.workdir), `.${namespace}`);
  const hash = projectHash(opts.workdir);
  const projectDir = join(home, "projects", hash);
  return {
    home,
    namespace,
    projectConfigDir,
    hash,
    spillDir: join(projectDir, "spill"),
    sessionsDir: join(projectDir, "sessions"),
    tasksDir: join(projectDir, "tasks"),
    globalSkillsDir: join(home, "skills"),
    projectSkillsDir: join(projectConfigDir, "skills"),
    globalAgentsDir: join(home, "agents"),
    projectAgentsDir: join(projectConfigDir, "agents"),
  };
}
