# 快速上手

本页用四步带你从安装走到一个带权限闸门的多轮 agent。

## 1. 安装

```bash
pnpm add @lite-agent/sdk @lite-agent/provider zod
```

- `@lite-agent/sdk` —— 开箱即用的 agent（`query` / `createLiteAgent` / `tool`）；完整转出 `@lite-agent/core`。
- `@lite-agent/provider` —— 模型 provider（`anthropic()` / `openai()`）。
- `zod` —— 工具入参 schema。

## 2. 第一个 `query()`

`query()` 运行一个一次性 agent，并流式产出类型化的 `AgentEvent`：

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

开箱即用，agent 已经拥有作用域限定在 `cwd` 的默认工具（`bash`、`read_file`、`write_file`、`edit_file`、`delete_file`）。生成器最终 resolve 为一个 `LiteAgentResult`（`messages`、`text`、`usage`、`stopReason`）。

## 3. 添加自定义工具

用 `tool()` 从 Zod schema 定义工具，通过 `tools` 传入，并用 `allowedTools` 收窄模型可见的工具集：

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

`allowedTools` 是对内置工具加自定义工具的精确名称白名单——不在名单里的工具在模型看到之前就被移除。

## 4. 多轮会话 + 权限闸门

`createLiteAgent(cfg)` 返回一个有状态、持有当前会话的 `LiteAgent`——连续的 `send()` 调用共享同一段对话。加上 `policy({ ask: [...] })` 权限闸门（工具名 glob 匹配，优先级 `deny > ask > allow`）和一个 `onApproval` 处理器，即可让人进入环路：

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

当模型调用 `write_file` 时，内核发出 `approval_request` 事件、挂起该工具调用，等待你的处理器返回 `"allow"` 或 `"deny"`。

:::tip
`LiteAgent` 还提供会话管理：`resume(id)`、`clear()`、`listSessions()`、`deleteSession(id)`，通过 `listCheckpoints(id)` / `restore(id, seq)` 做时间回溯，以及手动 `compact()`。见[会话](/zh/sdk/core-concepts/sessions)与[检查点](/zh/sdk/control/checkpointing)。
:::

## 另请参阅

- [代理循环](/zh/sdk/core-concepts/agent-loop) —— 内核轮次循环如何工作。
- [事件](/zh/sdk/core-concepts/events) —— 完整的 `AgentEvent` 参考。
- [权限](/zh/sdk/control/permissions) —— 内容级规则、审计与试运行。
- [模型 provider](/zh/core/providers) —— Anthropic、OpenAI 及 OpenAI 兼容本地端点。
- [核心策略](/zh/core/strategies) —— 用内核原语构建自己的 agent。
