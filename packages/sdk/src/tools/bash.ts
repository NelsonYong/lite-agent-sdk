import { execSync, spawn as spawnChild } from "node:child_process";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool, ToolContext } from "@lite-agent/core";

const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
// Foreground commands get a hard timeout so the agent can't hang waiting on them.
// Background (detached) commands are bounded by their AbortSignal instead
// (KillBackground / run-end cancelAll); a timeout would kill the servers/watchers this is for.
const SYNC_OPTS = { encoding: "utf8" as const, maxBuffer: 50_000_000, timeout: 120000 };

async function resolveCommand(command: string, workdir: string, ctx: ToolContext): Promise<string> {
  return ctx.sandbox ? await ctx.sandbox.wrap(command, { cwd: workdir }) : command;
}

function formatExecError(e: unknown): string {
  const err = e as { stdout?: string; stderr?: string; message?: string };
  return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(0, 50_000) || `Error: ${err.message}`;
}

function runSync(toRun: string, workdir: string): string {
  try {
    const out = execSync(toRun, { ...SYNC_OPTS, cwd: workdir });
    return out.trim() || "(no output)";
  } catch (e) {
    return formatExecError(e);
  }
}

// Streaming child for a detached (background) command: stdout+stderr are pushed to the
// task's output buffer via `write` (readable with BashOutput); resolves with a short tail
// summary on exit. Bounded only by `signal` (KillBackground / run-end).
function runStreaming(toRun: string, workdir: string, signal: AbortSignal, write: (s: string) => void): Promise<string> {
  return new Promise<string>((resolve) => {
    const child = spawnChild(toRun, { cwd: workdir, shell: true, signal });
    // Decode as UTF-8 so a multibyte character split across chunk boundaries isn't corrupted.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    let tail = "";
    const onData = (s: string) => { write(s); tail = (tail + s).slice(-2000); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // Deliberately resolve (never reject) on failure: a background command that errors or exits
    // non-zero is a normal, readable outcome — its output/status is the payload, not a tool error.
    child.on("error", (e) => resolve(`Error: ${(e as Error).message}`));
    child.on("close", (code, sig) => resolve(`[${sig ? `killed ${sig}` : `exit ${code}`}] ${tail.trim().slice(-500)}`.trim()));
  });
}

export function bashTool(workdir: string): Tool {
  return defineTool({
    name: "bash",
    description:
      "Run a shell command in the workspace — builds, tests, git, package managers, and searching or listing files (grep, find, ls). IMPORTANT: to read a file's contents, use the dedicated read_file tool instead of cat/head/tail; it is the preferred way and keeps whole files out of the shell output. Set run_in_background:true for long-running commands (servers, watchers, slow test suites): the command runs detached and does NOT block; read its output with the BashOutput tool (by the returned bg_… id), and it is stopped automatically when the run ends.",
    schema: z.object({
      command: z.string(),
      run_in_background: z.boolean().optional().default(false),
    }),
    execute: async ({ command, run_in_background }, ctx) => {
      if (DANGEROUS.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
      const toRun = await resolveCommand(command, workdir, ctx);
      if (run_in_background && ctx.background) {
        const handle = ctx.background.spawn({
          label: command,
          kind: "detached",
          run: (signal, _emit, write) => runStreaming(toRun, workdir, signal, write),
        });
        return `[background:${handle.id}] started: ${command}. Read output with BashOutput(id: ${handle.id}); it does not block this run and is stopped when the run ends.`;
      }
      // No registry (background disabled) → run synchronously as a graceful fallback.
      return runSync(toRun, workdir);
    },
  });
}
