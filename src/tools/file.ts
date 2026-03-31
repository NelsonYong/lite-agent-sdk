import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { safePath } from "../main";
import { dirname } from "node:path";


export const FILE_TOOL_SCHEMA = [
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
]


// 读取文件的日志输出， e.g Read [file.txt] L1-55
function LogReadFile(path: string, start: number, end: number) {
  // 带颜色
  console.log(`\x1b[32mRead [${path}] L${start}-${end}\x1b[0m`);
}

// 写入文件的日志输出， e.g Write [file.txt] 55 bytes
function LogWriteFile(path: string) {
  console.log(`\x1b[32mWrite [${path}] \x1b[0m`);
}

// 编辑文件的日志输出， e.g Edit [file.txt] L1-55
function LogEditFile(path: string, start: number, end: number) {
  console.log(`\x1b[32mEdit [${path}] L${start}-${end}\x1b[0m`);
}


// 读取文件
export async function readFile(path: string, limit: number) {

  try {
    const lines = readFileSync(safePath(path), "utf8").split("\n");
    // log
    LogReadFile(path, 1, lines.length);
    if (limit && limit < lines.length) {
      return [
        ...lines.slice(0, limit),
        `... (${lines.length - limit} more lines)`,
      ]
        .join("\n")
        .slice(0, 50000);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export function writeFile(path: string, content: string) {
  try {
    const fp = safePath(path);
    mkdirSync(dirname(fp), { recursive: true });
    // log
    LogWriteFile(path);
    writeFileSync(fp, content);
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export function editFile(path: string, old_text: string, new_text: string) {
  try {
    const fp = safePath(path);
    let content = readFileSync(fp, "utf8");
    if (!content.includes(old_text)) return `Error: Text not found in ${path}`;
    content = content.replace(old_text, new_text);
    // log
    LogEditFile(path, old_text.length, new_text.length);
    writeFileSync(fp, content);
    return `Edited ${path}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}