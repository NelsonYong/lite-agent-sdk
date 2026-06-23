import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";

const MAX_BYTES = 50_000;

export function makeSafePath(workdir: string): (p: string) => string {
  const root = resolve(workdir);
  return (p: string): string => {
    const full = resolve(root, p);
    if (full !== root && !full.startsWith(root + "/")) {
      throw new Error(`Path escapes workspace: ${p}`);
    }
    return full;
  };
}

export function fileTools(workdir: string): Tool[] {
  const safePath = makeSafePath(workdir);

  const readFile = defineTool({
    name: "read_file",
    description: "Read file contents.",
    schema: z.object({ path: z.string(), limit: z.number().int().optional() }),
    execute: ({ path, limit }) => {
      const lines = readFileSync(safePath(path), "utf8").split("\n");
      if (limit && limit < lines.length) {
        return [
          ...lines.slice(0, limit),
          `... (${lines.length - limit} more lines)`,
        ]
          .join("\n")
          .slice(0, MAX_BYTES);
      }
      return lines.join("\n").slice(0, MAX_BYTES);
    },
  });

  const writeFile = defineTool({
    name: "write_file",
    description: "Write content to a file.",
    schema: z.object({ path: z.string(), content: z.string() }),
    execute: ({ path, content }) => {
      const fp = safePath(path);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content);
      return `Wrote ${content.length} bytes to ${path}`;
    },
  });

  const editFile = defineTool({
    name: "edit_file",
    description: "Replace exact text in a file.",
    schema: z.object({
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
    }),
    execute: ({ path, old_text, new_text }) => {
      const fp = safePath(path);
      const content = readFileSync(fp, "utf8");
      if (!content.includes(old_text))
        return `Error: Text not found in ${path}`;
      writeFileSync(fp, content.replace(old_text, new_text));
      return `Edited ${path}`;
    },
  });

  return [readFile, writeFile, editFile];
}
