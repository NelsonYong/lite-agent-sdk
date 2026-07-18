# 结构化输出

自由文本回答适合聊天，但当你的 agent 要为另一个程序供数时，你需要的是**带类型、经过校验的结果**，而不是需要解析的散文。设置 `outputSchema`（一个 Zod object schema），运行的最终答案就会被强制通过它：SDK 注册一个以你的 schema 为参数的 `final_answer` 工具，指示模型在完成时恰好调用一次，校验入参，并将其暴露为 `result.output`。

## 用法

```ts
import { createLiteAgent } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { z } from "zod";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  outputSchema: z.object({
    name: z.string(),
    deps: z.number(),
  }),
});

const result = await agent.send("Summarize package.json");
result.output; // { name: "…", deps: 42 } — validated against the schema
```

`query()` 接受相同的选项。它的生成器 resolve 出 `LiteAgentResult`，如果需要 `result.output`，请手动驱动它：

```ts
import { query } from "@lite-agent/sdk";

const run = query({
  prompt: "Summarize package.json",
  model: anthropic(),
  cwd: process.cwd(),
  outputSchema: z.object({ name: z.string(), deps: z.number() }),
});

let result;
while (!(result = await run.next()).done) {
  // stream events as usual: result.value is an AgentEvent
}
result.value.output; // LiteAgentResult.output
```

## 工作原理

1. 注册一个 `final_answer` 工具，以你的 schema 作为其入参 schema，因此模型只能产出结构上合法的参数。
2. 向[系统提示词](/zh/sdk/behavior/system-prompt)追加一个 `## Final answer` 小节：模型必须在任务完成时恰好调用一次 `final_answer`，且只有这次调用会被读取为答案。
3. 工具 handler 为当前 session 记录校验后的参数；运行结束时，它们被附加为 `result.output`。

`LiteAgentResult` 的类型是 `RunResult & { output?: unknown }` —— 只有设置了 `outputSchema` 且模型产出了最终答案时，`output` 才存在。

## 细节

| 方面 | 行为 |
| --- | --- |
| Schema 形状 | 必须是 Zod **object** schema；其字段成为 `final_answer` 的参数。 |
| 校验 | 参数在记录前经 schema 校验；不合法的调用会以普通工具错误的形式暴露，模型可以纠正。 |
| `result.output` | 该 session 的 `final_answer` 调用的校验后参数，附加在 `send()` / `query()` 返回的 `LiteAgentResult` 上。 |
| 副作用 | `final_answer` 声明为 `network: "none"`、`filesystem: "none"`、`sideEffects: "none"` —— 它只记录答案。 |
| Subagents | `outputSchema` **不会**被 [subagents](/zh/sdk/tools/subagents) 继承；每个子 agent 返回纯文本。 |

## 另请参阅

- [系统提示词](/zh/sdk/behavior/system-prompt) —— `outputSchema` 如何用 `## Final answer` 小节扩展提示词。
- [Subagents](/zh/sdk/tools/subagents) —— 为什么子 agent 不继承 schema。
- [快速上手](/zh/sdk/getting-started) —— 安装并运行你的第一个 agent。
