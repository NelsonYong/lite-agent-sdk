import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

/** Global home: `$LITE_AGENT_HOME` if set, else `~/.lite-agent`. */
export function liteAgentHome(): string {
  return process.env.LITE_AGENT_HOME || join(homedir(), ".lite-agent");
}

/** Stable per absolute project path: first 16 hex of sha1(resolve(workdir)). */
export function projectHash(workdir: string): string {
  return createHash("sha1").update(resolve(workdir)).digest("hex").slice(0, 16);
}

export interface ProjectPaths {
  home: string;
  hash: string;
  spillDir: string;
  sessionsDir: string;
  tasksDir: string;
  globalSkillsDir: string;
  projectSkillsDir: string;
}

/** Pure: derive every path from `workdir` (+ optional home). No fs side effects. */
export function resolveProjectPaths(opts: { workdir: string; home?: string }): ProjectPaths {
  const home = opts.home ?? liteAgentHome();
  const hash = projectHash(opts.workdir);
  const projectDir = join(home, "projects", hash);
  return {
    home,
    hash,
    spillDir: join(projectDir, "spill"),
    sessionsDir: join(projectDir, "sessions"),
    tasksDir: join(projectDir, "tasks"),
    globalSkillsDir: join(home, "skills"),
    projectSkillsDir: join(resolve(opts.workdir), ".lite-agent", "skills"),
  };
}
