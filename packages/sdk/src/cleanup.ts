import { existsSync, readdirSync, statSync, rmSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { liteAgentHome } from "./paths";

const DAY_MS = 86_400_000;

/**
 * Read a file's first line without loading the whole file. Returns undefined if
 * the file is empty or no newline appears within `maxBytes` (an unusually large
 * first record) — callers then must NOT classify it, leaving it to age-based GC.
 */
function firstLine(fp: string, maxBytes = 8192): string | undefined {
  const fd = openSync(fp, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    if (n === 0) return undefined;
    const slice = buf.subarray(0, n);
    const nl = slice.indexOf(0x0a); // '\n'
    if (nl === -1) {
      // If we read the entire file (n < maxBytes), the whole content is the first line.
      // If n === maxBytes the first record may extend beyond the window → don't classify.
      return n < maxBytes ? slice.toString("utf8") : undefined;
    }
    return slice.subarray(0, nl).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

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
            // Discard legacy whole-array transcripts (pre-event-sourcing, first line
            // lacks a numeric `seq`). An empty file or an over-long first record is
            // left to the age check below — never delete on an unclassifiable line.
            if (sub === "sessions" && name.endsWith(".jsonl")) {
              const first = firstLine(fp);
              if (first !== undefined && first.trim() !== "") {
                let legacy = false;
                try {
                  const o = JSON.parse(first) as { seq?: unknown };
                  legacy = typeof o?.seq !== "number";
                } catch {
                  legacy = true; // unparseable first line → garbage/legacy
                }
                if (legacy) { rmSync(fp); continue; }
              }
            }
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
