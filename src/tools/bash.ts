import { execSync } from "child_process";

export const BASH_TOOL_SCHEMA = {
  name: "bash",
  description: "Run a shell command.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "The shell command to run" },
    },
    required: ["command"],
  },
};

// log bash 命令
function LogBashCommand(command: string) {
  // 打印格式 Bash(command)
  console.log(`\x1b[32mBash(${command})\x1b[0m`);
}

// 运行 bash 命令
export function runBash(command: string) {
  // 危险命令, 后续需要通过统一管道过滤
  const dangerousCommands = [
    "rm -rf /",
    "sudo",
    "shutdown",
    "reboot",
    "> /dev/",
  ];
  if (dangerousCommands.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  try {
    LogBashCommand(command);
    // 执行命令
    const output = execSync(command, {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 50000000,
    });
    return output.trim() || "(no output)";
  } catch (e: any) {
    // 返回错误信息
    return (
      (e.stdout + e.stderr).trim().slice(0, 50000) || `Error: ${e.message}`
    );
  }
}
