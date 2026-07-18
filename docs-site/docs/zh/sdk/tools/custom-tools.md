# 自定义工具

工具是模型作用于世界的途径。除了[内置工具](/zh/sdk/tools/builtin-tools)，`tool()` 还能让你用一个 Zod schema 定义自己的工具——一个模型可以调用的类型化函数。schema 会在你的代码运行前校验每次调用，因此 handler 只会看到格式合法的入参。自定义工具追加在内置工具之后，同样经过[权限闸门](/zh/sdk/control/permissions)和 `allowedTools` / `disallowedTools` 过滤。

## 定义工具

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

## `tool()` 签名

```ts
tool(name, description, schema, handler, opts?)
```

| 参数 | 说明 |
| --- | --- |
| `name` | 模型调用时使用的工具名（被 `allowedTools` / `disallowedTools` 和权限规则匹配）。 |
| `description` | 展示给模型的描述；告诉它何时、为何使用该工具。 |
| `schema` | 一个 Zod schema。非法的模型入参会在 handler 运行前被拒绝。 |
| `handler` | `(input, ctx: ToolContext) => string \| Promise<string>`——返回值即模型看到的工具结果。 |
| `opts.security` | 可选的[安全元数据](#安全元数据)。 |

## `ToolContext`

handler 的第二个参数携带内核提供的逐次调用服务：

| 字段 | 说明 |
| --- | --- |
| `sessionId` | 本次调用所属的会话。 |
| `signal` | 用于取消的 `AbortSignal`。 |
| `emit(ev)` | 在调用中途发出自定义 `AgentEvent`。 |
| `approval` / `input` | 审批 / 用户输入处理器（如已配置）。 |
| `sandbox` | 当前生效的 `Sandbox` 策略（如有）。 |
| `background` | 后台任务注册表（启用 `background` 时）。 |
| `call` | 正在执行的原始 `ToolCall`。 |
| `recordSnapshot(...)` | 记录文件改动前的内容，使会话恢复可以撤销改动（仅在 checkpointer 激活时由内核提供）。 |

## 安全元数据

`opts.security` 声明工具能触及的范围，类型为 `ToolSecurity`：

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `network`（必填） | `"none"` \| `"loopback"` \| `"private"` \| `"unrestricted"` | 工具的网络可达性。 |
| `filesystem` | `"none"` \| `"workspace"` \| `"unrestricted"` | 工具触及的文件系统范围。 |
| `sideEffects` | `"none"` \| `"workspace"` \| `"external"` | 工具副作用落地的范围。 |

严格装配器会消费这份元数据：`@lite-agent/local` 会拒绝缺少 `security` 或 `network` 超出 `"loopback"` 的自定义工具。请如实声明——加固预设正是据此决定你的工具能否运行。

## 另请参阅

- [内置工具](/zh/sdk/tools/builtin-tools)——SDK 自带的工具集。
- [权限](/zh/sdk/control/permissions)——用 allow / ask / deny 规则门控自定义与内置工具。
- [Agent SDK 概览](/zh/sdk/overview)——自定义工具在组装好的 agent 中的位置。
- [CLI 示例](/zh/examples/cli)——一个端到端接入自定义工具的完整 agent。
