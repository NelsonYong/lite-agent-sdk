# 快速上手

本页用四步带你从安装走到一个带权限门控的多轮 agent。

## 1. 安装

```bash
pnpm add @lite-agent/sdk @lite-agent/provider zod
```

- `@lite-agent/sdk` —— 开箱即用的 agent（`query` / `createLiteAgent` / `tool`）；完整重导出 `@lite-agent/core`。
- `@lite-agent/provider` —— 模型 provider（`anthropic()` / `openai()`）。
- `zod` —— 工具入参 schema。

## 2. 第一个 `query()`

`query()` 执行一次性的 agent 运行，并流式产出类型化的 `AgentEvent`：

```ts
import { query } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

for await (const ev of query({
  prompt: "List the files here and summarize what this project does.",
  model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  modelName: "claude-sonnet-4-6",
  cwd: process.cwd(),
})) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

开箱即用，agent 已经拥有作用域限定在 `cwd` 的默认工具（`bash`、`read_file`、`write_file`、`edit_file`、`delete_file`）。生成器最终 resolve 出一个 `LiteAgentResult`（`messages`、`text`、`usage`、`stopReason`）。

## 3. 加自定义工具

用 `tool()` 从 Zod schema 定义一个工具，通过 `tools` 传入，并用 `allowedTools` 收敛模型可见的工具集：

```ts
import { query, tool } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { z } from "zod";

const weather = tool(
  "get_weather",
  "Get the weather for a city",
  z.object({ city: z.string() }),
  async ({ city }) => `It's sunny in ${city}.`,
);

for await (const ev of query({
  prompt: "What's the weather in Tokyo?",
  model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  modelName: "claude-sonnet-4-6",
  tools: [weather],
  allowedTools: ["get_weather", "read_file"],
})) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

`allowedTools` 是针对内置工具 + 自定义工具的精确名字白名单 —— 不在列表里的工具在模型看到之前就被移除。

## 4. 多轮会话 + 权限门控

`createLiteAgent(cfg)` 返回一个有状态的 `LiteAgent`，它持有当前会话 —— 连续的 `send()` 调用共享同一段对话。加上 `policy({ ask: [...] })` 权限门控（按工具名 glob 匹配，优先级 `deny > ask > allow`）和 `onApproval` 处理器，即可实现人工审批：

```ts
import { createLiteAgent, policy } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { createInterface } from "node:readline/promises";

const agent = createLiteAgent({
  model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  // Every bash / write_file / edit_file call pauses for approval.
  permission: policy({ ask: ["bash", "write_file", "edit_file"] }),
  onApproval: {
    async request(call) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Allow ${call.name} ${JSON.stringify(call.input)}? [y/N] `);
      rl.close();
      return answer.trim().toLowerCase() === "y" ? "allow" : "deny";
    },
  },
});

const first = await agent.send("Create hello.txt with a short greeting.");
console.log(first.text);

const second = await agent.send("Now read it back to me."); // same session
console.log(second.text);
```

当模型调用 `write_file` 时，内核会发出 `approval_request` 事件、挂起该工具调用，并等待你的处理器返回 `"allow"` 或 `"deny"`。

:::tip
`LiteAgent` 还提供会话管理：`resume(id)`、`clear()`、`listSessions()`、`deleteSession(id)`，通过 `listCheckpoints(id)` / `restore(id, seq)` 进行时间回溯，以及手动 `compact()`。详见 [`@lite-agent/sdk`](/zh/packages/sdk)。
:::

## 下一步

- [核心概念](/zh/guide/core-concepts) —— 内核轮次循环、九种策略、洋葱中间件，以及完整的 `AgentEvent` 参考。
- [`@lite-agent/sdk`](/zh/packages/sdk) —— 技能、子代理、任务、结构化输出、可观测性。
- [`@lite-agent/core`](/zh/packages/core) —— 用内核原语组装你自己的 agent。
- [`@lite-agent/provider`](/zh/packages/provider) —— Anthropic、OpenAI 与 OpenAI 兼容的本地端点。
