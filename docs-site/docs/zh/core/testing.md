# 测试工具

内核可以在完全没有网络的情况下测试。`@lite-agent/core` 内置了一个脚本化的 `ModelProvider` 测试替身（`fakeProvider`），让 agent 循环的测试完全确定；外加两套一致性测试套件——`providerConformance` 和 `checkpointerConformance`——用来验证任何自定义策略实现是否满足内核所依赖的精确契约。如果你写了自己的 provider 或持久化后端，跑这两套套件是确认契约实现正确的最低成本方式。

## 用 `fakeProvider` 脚本化模型

`fakeProvider(turns)` 按顺序回放脚本化的 `FakeTurn`（`{ text?, message, usage? }`）——确定性、零网络。用它可以在单元测试里驱动完整的内核循环：

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]),
  codec: nativeCodec(),
});

const result = await agent.send("hello");
console.log(result.text); // "hi"
```

每个脚本化轮次可以携带文本、一条完整的 assistant 消息（包括 `tool_call` 块，用于覆盖工具执行阶段）以及 `usage` 记录。因为 `fakeProvider` 是一个真正的 `ModelProvider`，它周围的一切——中间件、codec、checkpointer、权限门——都以与生产完全一致的方式运行。

## `providerConformance`

一组命名测试用例，任何 `ModelProvider` 都必须通过：文本增量顺序、恰好一个终止 `message_done`、错误映射为 `ProviderError`、abort 处理。给它一个能按 `ProviderConformanceScenario` 构造你的 provider 的 `ProviderConformanceFactory`：

```ts
import { providerConformance } from "@lite-agent/core";

for (const test of providerConformance) {
  it(test.name, () => test.run((scenario) => makeMyProvider(scenario)));
}
```

受维护的 `anthropic()` 和 `openai()` 适配器通过注入 client 的接缝离线跑过这套套件。

## `checkpointerConformance`

`Checkpointer` 后端的同款套件：单调 seq、`sinceSeq` 回放、冲突拒绝（`expectedHead` 过期时抛 `CheckpointConflictError`）、list/delete、并发 append 串行化、payload 往返：

```ts
import { checkpointerConformance } from "@lite-agent/core";

for (const test of checkpointerConformance) {
  it(test.name, () => test.run(() => myCheckpointer()));
}
```

[SQLite 后端](/zh/core/persistence)就是用这套套件自验的——SDK 默认的 `fileCheckpointer` 跑的也是同一套。在把自有后端用于真实会话之前，先跑一遍。

## 另请参阅

- [模型提供方](/zh/core/providers)——注入 client 的离线测试，以及面向真实服务器的端点探测。
- [会话持久化](/zh/core/persistence)——一致性套件所验证的 `Checkpointer` 契约。
- [工具调用 codec](/zh/core/codecs)——用 `fakeProvider` 端到端验证自定义 codec。
- [九种策略](/zh/core/strategies)——两套套件背后的策略契约。
