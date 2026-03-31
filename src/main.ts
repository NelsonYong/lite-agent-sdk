import dotenv from "dotenv";
import { liteAgent } from "./agent";
import { MessageParam } from "@anthropic-ai/sdk/resources";
import { resolve, join } from "node:path";
import { initSkillLoader } from "./agent/skill";
import { buildMainAgentPrompt } from "./prompt/system";
import { BUS, TEAM } from "./agent/agentTeam";
dotenv.config();

// 确定工作空间，不让 agent 逃逸出工作空间
const WORKDIR = process.cwd();

// 全局初始化一次，system.ts 和 tools/index.ts 共用同一实例
initSkillLoader(join(WORKDIR, "skills"));

const SYSTEM = buildMainAgentPrompt(WORKDIR);

// 操作文件一定只能操作工作空间内的文件
export function safePath(p: string) {
  const path = resolve(WORKDIR, p);
  if (!path.startsWith(WORKDIR))
    throw new Error(`Path escapes workspace: ${p}`);
  return path;
}

async function main() {
  const history: MessageParam[] = [];
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () =>
    new Promise<string>((resolvePromise) => {
      const lines: string[] = [];
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let multilineMode = false;

      const submit = () => {
        rl.removeListener("line", onLine);
        resolvePromise(lines.join("\n"));
      };

      const onLine = (line: string) => {
        // 多行模式：空行提交，否则继续追加
        if (multilineMode) {
          if (line === "") {
            submit();
          } else {
            lines.push(line);
            process.stdout.write("\x1b[90m...  \x1b[0m");
          }
          return;
        }

        if (debounceTimer) clearTimeout(debounceTimer);
        lines.push(line);

        debounceTimer = setTimeout(() => {
          if (lines.length > 1) {
            // 检测到多行粘贴，进入多行模式，等待空行提交
            multilineMode = true;
            process.stdout.write(
              "\x1b[90m[多行模式：继续粘贴或输入空行提交]\x1b[0m\n\x1b[90m...  \x1b[0m",
            );
          } else {
            submit();
          }
        }, 50);
      };

      process.stdout.write("\x1b[36mlite-agent >> \x1b[0m");
      rl.on("line", onLine);
    });

  while (true) {
    const query = await prompt();
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;

    if (query.trim() === "/team") {
      console.log(TEAM.listAll());
      continue;
    }
    if (query.trim() === "/inbox") {
      console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
      continue;
    }

    const forceTool = query.startsWith("/todo") ? "todo" : undefined;
    history.push({
      role: "user",
      content: query.replace("/todo", "").trim() || "Update todos.",
    });

    // ESC 中断支持：暂停 readline，进入 raw mode 监听 ESC 键
    const ac = new AbortController();
    rl.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    const onKey = (key: Buffer) => {
      // ESC = 单独的 0x1b（排除方向键等多字节转义序列）
      if (key[0] === 0x1b && key.length === 1) {
        ac.abort();
        console.log("\n\x1b[33m[ESC] 中断当前循环\x1b[0m");
      }
    };
    process.stdin.on("data", onKey);

    try {
      await liteAgent({
        messages: history,
        system: SYSTEM,
        forceTool,
        signal: ac.signal,
      });
    } finally {
      process.stdin.removeListener("data", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      rl.resume();
    }

    // 取出最后一个消息的 content
    const lastContent = history[history.length - 1].content;

    //  打印最后一个消息的 content
    if (Array.isArray(lastContent)) {
      for (const block of lastContent) {
        if (block.type === "text") console.log(block.text);
      }
    } else console.log(lastContent);
  }
  rl.close();
}

main().catch(console.error);
