import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { liteAgentHome } from "./paths";

const DAY_MS = 86_400_000;

/**
 * Delete stale runtime files under <home>/projects/HASH/spill and
 * <home>/projects/HASH/sessions whose mtime is older than maxAgeDays
 * (default 30). Global sweep, synchronous, fully guarded -- a failure
 * here must never block agent startup.
 */
export function sweepStale(opts: { home?: string; maxAgeDays?: number } = {}): void {
  const home = opts.home ?? liteAgentHome();
  const cutoff = Date.now() - (opts.maxAgeDays ?? 30) * DAY_MS;
  try {
    const projectsDir = join(home, "projects");
    if (!existsSync(projectsDir)) return;
    for (const project of readdirSync(projectsDir)) {
      for (const sub of ["spill", "sessions"]) {
        const dir = join(projectsDir, project, sub);
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          const fp = join(dir, name);
          try {
            if (statSync(fp).mtimeMs < cutoff) rmSync(fp);
          } catch {
            /* skip a file that vanished or can't be stat'd */
          }
        }
      }
    }
  } catch {
    /* never block startup on cleanup */
  }
}
