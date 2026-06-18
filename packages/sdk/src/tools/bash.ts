import { execSync } from "node:child_process";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";

const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

export function bashTool(workdir: string): Tool {
  return defineTool({
    name: "bash",
    description: "Run a shell command.",
    schema: z.object({ command: z.string() }),
    execute: ({ command }) => {
      if (DANGEROUS.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
      try {
        const out = execSync(command, { cwd: workdir, encoding: "utf8", timeout: 120000, maxBuffer: 50_000_000 });
        return out.trim() || "(no output)";
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(0, 50_000) || `Error: ${err.message}`;
      }
    },
  });
}
