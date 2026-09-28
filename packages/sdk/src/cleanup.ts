import { existsSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { liteAgentHome } from "./paths";

const DAY_MS = 86_400_000;

/**
 * Delete stale runtime files under <home>/projects/HASH/spill and
 * <home>/projects/HASH/sessions whose mtime is older than maxAgeDays
 * (default 30). Global sweep, synchronous, fully guarded -- a failure
 * here must never block agent startup.
 */
export function sweepStale(opts: { home?: string; maxAgeDays?: number; maxBytes?: number } = {}): void {
  const home = opts.home ?? liteAgentHome();
  const cutoff = Date.now() - (opts.maxAgeDays ?? 30) * DAY_MS;
  try {
    const projectsDir = join(home, "projects");
    if (!existsSync(projectsDir) || lstatSync(projectsDir).isSymbolicLink()) return;
    const kept: Array<{ path: string; size: number; mtime: number }> = [];
    for (const project of readdirSync(projectsDir)) {
      const projectDir = join(projectsDir, project);
      if (lstatSync(projectDir).isSymbolicLink() || !lstatSync(projectDir).isDirectory()) continue;
      for (const sub of ["spill", "sessions"]) {
        const dir = join(projectsDir, project, sub);
        if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) continue;
        for (const name of readdirSync(dir)) {
          const fp = join(dir, name);
          try {
            const stat = lstatSync(fp);
            if (stat.isSymbolicLink() || name.endsWith(".lock") || existsSync(`${fp}.lock`)) continue;
            if (stat.mtimeMs < cutoff) rmSync(fp, { recursive: stat.isDirectory(), force: true });
            else if (stat.isFile()) kept.push({ path: fp, size: stat.size, mtime: stat.mtimeMs });
          } catch {
            /* skip a file that vanished or can't be stat'd */
          }
        }
      }
    }
    if (opts.maxBytes !== undefined && Number.isFinite(opts.maxBytes) && opts.maxBytes >= 0) {
      let total = kept.reduce((sum, file) => sum + file.size, 0);
      for (const file of kept.sort((a, b) => a.mtime - b.mtime)) {
        if (total <= opts.maxBytes) break;
        try { rmSync(file.path); total -= file.size; } catch { /* best-effort cleanup */ }
      }
    }
  } catch {
    /* never block startup on cleanup */
  }
}
