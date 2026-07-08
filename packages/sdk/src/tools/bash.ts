import { execSync, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool, ToolContext } from "@lite-agent/core";

const execAsync = promisify(execCb);
const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
const SHARED_OPTS = { encoding: "utf8" as const, maxBuffer: 50_000_000 };
// Foreground commands get a hard timeout so the agent can't hang waiting on them.
// Background commands are bounded by their AbortSignal instead (KillBackground /
// run-abort); a 2-minute cap would kill the servers/watchers this feature is for.
const SYNC_OPTS = { ...SHARED_OPTS, timeout: 120000 };

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

async function runAsync(toRun: string, workdir: string, signal: AbortSignal): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(toRun, { ...SHARED_OPTS, cwd: workdir, signal });
    // Unlike execSync (where stderr streams to the parent), async exec captures it —
    // include stderr so a background task's success output isn't silently dropped.
    return `${stdout}${stderr}`.trim() || "(no output)";
  } catch (e) {
    return formatExecError(e);
  }
}

export function bashTool(workdir: string): Tool {
  return defineTool({
    name: "bash",
    description:
      "Run a shell command in the workspace — builds, tests, git, package managers, and searching or listing files (grep, find, ls). IMPORTANT: to read a file's contents, use the dedicated read_file tool instead of cat/head/tail; it is the preferred way and keeps whole files out of the shell output. Set run_in_background:true for long-running commands (servers, watchers, slow test suites); its output is delivered to you automatically when it finishes.",
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
          run: (signal) => runAsync(toRun, workdir, signal),
        });
        return `[background:${handle.id}] started: ${command}. Output will be delivered when it completes.`;
      }
      // No registry (background disabled) → run synchronously as a graceful fallback.
      return runSync(toRun, workdir);
    },
  });
}
