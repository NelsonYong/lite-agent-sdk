import { execFileSync, spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool, ToolContext, ToolSecurity } from "@lite-agent/core";

const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

export interface BashToolOptions {
  timeoutMs?: number;
  /** Detached-command wall timeout. Undefined keeps the SDK's abort-only behavior. */
  backgroundTimeoutMs?: number;
  maxOutputBytes?: number;
  memoryBytes?: number;
  env?: NodeJS.ProcessEnv;
  security?: ToolSecurity;
}

interface RuntimeOptions {
  timeoutMs?: number;
  maxOutputBytes: number;
  memoryBytes?: number;
  env?: NodeJS.ProcessEnv;
}

async function resolveCommand(command: string, workdir: string, ctx: ToolContext): Promise<string> {
  return ctx.sandbox ? await ctx.sandbox.wrap(command, { cwd: workdir }) : command;
}

function processTreeRss(rootPid: number): number | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], {
      encoding: "utf8", timeout: 3000, maxBuffer: 5_000_000,
    });
    const rows = output.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
    const children = new Map<number, number[]>();
    const rss = new Map<number, number>();
    for (const [pid, ppid, kb] of rows) {
      if (!pid || ppid === undefined || kb === undefined) continue;
      rss.set(pid, kb * 1024);
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
    let total = 0;
    const queue = [rootPid];
    const seen = new Set<number>();
    while (queue.length) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      total += rss.get(pid) ?? 0;
      queue.push(...(children.get(pid) ?? []));
    }
    return total;
  } catch { return undefined; }
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
}

function runProcess(
  command: string,
  workdir: string,
  signal: AbortSignal,
  opts: RuntimeOptions,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const child = spawnChild(command, {
      cwd: workdir,
      shell: true,
      signal,
      env: opts.env,
      detached: process.platform !== "win32",
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    let output = "";
    let bytes = 0;
    let limitError: string | undefined;
    let memoryProbeFailures = 0;
    let settled = false;
    const settle = (value: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (memoryTimer) clearInterval(memoryTimer);
      resolve(value);
    };
    const failLimit = (message: string) => {
      if (limitError) return;
      limitError = message;
      killTree(child);
    };
    const data = (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > opts.maxOutputBytes) {
        failLimit(`Error: command output exceeded ${opts.maxOutputBytes} bytes`);
        return;
      }
      output += chunk;
      onChunk?.(chunk);
    };
    child.stdout?.on("data", data);
    child.stderr?.on("data", data);
    child.on("error", (error) => settle(limitError ?? `Error: ${error.message}`));
    child.on("close", (code, sig) => {
      if (limitError) { settle(limitError); return; }
      const body = output.trim();
      if (onChunk) settle(`[${sig ? `killed ${sig}` : `exit ${code}`}] ${body.slice(-500)}`.trim());
      else settle(body || (code === 0 ? "(no output)" : `Error: command exited with code ${code}`));
    });
    const timeout = opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          failLimit(`Error: command timed out after ${opts.timeoutMs}ms`);
        }, opts.timeoutMs);
    const memoryTimer = opts.memoryBytes && child.pid && process.platform !== "win32"
      ? setInterval(() => {
          const used = processTreeRss(child.pid!);
          if (used === undefined) {
            memoryProbeFailures++;
            if (memoryProbeFailures >= 3) failLimit("Error: command memory monitoring unavailable");
            return;
          }
          memoryProbeFailures = 0;
          if (used > opts.memoryBytes!)
            failLimit(`Error: command memory exceeded ${opts.memoryBytes} bytes`);
        }, 100)
      : undefined;
  });
}

export function bashTool(workdir: string, opts: BashToolOptions = {}): Tool {
  const foreground: RuntimeOptions = {
    timeoutMs: opts.timeoutMs ?? 120_000,
    maxOutputBytes: opts.maxOutputBytes ?? 50_000_000,
    memoryBytes: opts.memoryBytes,
    env: opts.env,
  };
  const background: RuntimeOptions = { ...foreground, timeoutMs: opts.backgroundTimeoutMs };
  return defineTool({
    name: "bash",
    description:
      "Run a shell command in the workspace — builds, tests, git, package managers, and searching or listing files (grep, find, ls). IMPORTANT: to read a file's contents, use the dedicated read_file tool instead of cat/head/tail; it is the preferred way and keeps whole files out of the shell output. Set run_in_background:true for long-running commands (servers, watchers, slow test suites): the command runs detached across later turns of the same live session and does NOT block; read its output with the BashOutput tool (by the returned bg_… id). It is stopped by KillBackground, session deletion, configured limits, or LiteAgent.close().",
    schema: z.object({ command: z.string(), run_in_background: z.boolean().optional().default(false) }),
    security: opts.security ?? { network: "unrestricted", filesystem: "unrestricted", sideEffects: "external" },
    execute: async ({ command, run_in_background }, ctx) => {
      if (DANGEROUS.some((dangerous) => command.includes(dangerous))) return "Error: Dangerous command blocked";
      const toRun = await resolveCommand(command, workdir, ctx);
      if (run_in_background && ctx.background) {
        const handle = ctx.background.spawn({
          label: command,
          kind: "detached",
          awaitIdle: false,
          run: (signal, _emit, write) => runProcess(toRun, workdir, signal, background, write),
        });
        return `[background:${handle.id}] started: ${command}. Read output with BashOutput(id: ${handle.id}); it continues across turns and is stopped by KillBackground, session deletion, configured limits, or LiteAgent.close().`;
      }
      return runProcess(toRun, workdir, ctx.signal, foreground);
    },
  });
}
