# 主流厂商与 AI SDK

从 `@lite-agent/provider` 0.11.0 起，使用 `aiSdk(model, options?)` 接入 Vercel AI SDK 7 的 **LanguageModelV4** 模型。要求 **Node.js >=22**，不兼容旧 V2/V3 provider。

lite-agent 只维护规范化请求与流的桥接，HTTP、鉴权和厂商协议由对应的成熟 provider 处理。生产依赖不包含下表所有厂商包；宿主按需安装。不会引入 AI SDK 的第二套 agent 循环、默认 Gateway、额外重试或自动下载输入 URL。

## 接入示例

```bash
pnpm add @lite-agent/sdk @lite-agent/provider @ai-sdk/google
```

```ts
import { createLiteAgent } from '@lite-agent/sdk';
import { aiSdk } from '@lite-agent/provider';
import { createGoogle } from '@ai-sdk/google';

const google = createGoogle({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
const model = google(process.env.GEMINI_MODEL!);
const agent = createLiteAgent({
  workdir: process.cwd(),
  model: aiSdk(model, { context: { contextWindow: 128_000 } }),
});
try {
  console.log((await agent.send('分析这个项目')).text);
} finally {
  await agent.close();
}
```

示例窗口大小需按实际模型配置，SDK 不从模型名猜测。`aiSdk` 的 provider id 就是绑定的 `modelId`，因此普通调用可省略 `modelName`。显式传入时必须与绑定模型一致；多 agent 的 `models` 配置应为各模型创建对应实例，避免悄悄忽略模型选择。

## 厂商覆盖

完整列表已集中在 SDK 的[支持的厂商](/zh/sdk/models/providers)，包括接入包、创建模型方式、兼容端点与验证范围。协议区别见[支持的协议](/zh/sdk/models/protocols)。本页继续说明桥接 API 和多轮行为。

## 参数与多轮行为

- `maxTokens`、temperature、topP、stopSequences、seed、工具 schema 和 toolChoice 映射为 V4 标准参数。
- `reasoningEffort` 映射为 V4 `reasoning`，由官方 adapter 转成厂商字段；主/子 agent 可使用不同档位。已额外验证 OpenAI、Anthropic、Gemini 的 high 映射。
- 文本实时输出；思考内容作为模型专属 native 数据保留，不混进可见文本 delta。
- 工具 id、名称、完整参数及错误状态保留。工具执行仍经过 lite-agent 权限、Hook 和并发机制。
- 思考签名、OpenAI 加密思考状态和 assistant phase 按原模型保存并回传，可经过 JSON checkpoint 往返；跨厂商或跨模型 native 状态拒绝直接复用。
- 引用来源保存在 native 数据里供宿主读取，不自动打开或下载。当前统一适配支持文本、思考和函数工具；图像/音频/文件输出与 provider 代执行工具会明确报错，不静默丢弃或绕过本地权限。
- 取消和提前结束流会中止请求并关闭 reader；HTTP status 统一保存在 `ProviderError.status`。不添加重试，仍由现有 `retry()` 策略负责。
- 厂商返回 `unsupported` 警告时明确失败，避免忽略工具或思考设置；其余警告可通过 `onWarning` 观察。

## 厂商专属选项与存储

```ts
const provider = aiSdk(openaiModel, {
  providerOptions: { openai: { store: false } },
  onWarning: warning => console.warn(warning.type),
});
```

`providerOptions` 也可为接收当前 `ModelRequest` 的函数。SDK 不自动改变厂商的服务端存储/隐私策略；OpenAI Responses 可显式设置 `store: false`。这不是脱敏功能，也不是数据不出网的保证。

`context` 可以提供已知窗口或真实 token 计数能力；统一桥接不会自动声称具备原生压缩、精确计数或 prompt-cache 能力。需要 Anthropic 专属原生上下文管理时，现有 `anthropic()` 适配器仍可使用。

## 验证边界与资料

离线测试使用实际安装的厂商 SDK 和各自 HTTP/SSE/Bedrock 二进制事件样本，验证文本/工具多轮、签名及状态回放、usage、错误和不重试行为。没有厂商凭证的集成不标记为真机通过。真实调用脚本与运行记录保存在代理独立工作区，不进入仓库。

- [AI SDK providers](https://ai-sdk.dev/providers/ai-sdk-providers)
- [AI SDK 源码与标准接口](https://github.com/vercel/ai)
- [OpenAI reasoning 与 phase](https://developers.openai.com/api/docs/guides/reasoning#phase-parameter)
- [现有直接适配器与兼容性探测](/zh/core/providers)
