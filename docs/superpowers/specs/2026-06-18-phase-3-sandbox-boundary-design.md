# Phase 3 — 边界层:Sandbox 策略 + sandbox-runtime 适配器(设计)

> 主设计:[2026-06-18-agent-core-sdk-design.md](./2026-06-18-agent-core-sdk-design.md)
> 本文是 Phase 3「权限/审批/ask_user」之外**新增的一块**:给工具(尤其 `bash`)一个**运行时边界**。
> 权限闸门(`PermissionPolicy`/`ApprovalHandler`)主设计 §5–§6 已定;本文只补 `Sandbox` 策略与适配器。

**状态:** 已批准方向(联网调研后用户确认"写进 Phase 3 spec")。属设计增量,不改当前分支上已交付的代码。

## 1. 动机:两个正交机制,缺一不可

现状 `bashTool` 只有"危险命令子串黑名单"——它既不是闸门也不是边界,且可被 `SUDO`/多空格 `rm  -rf` 轻易绕过(Phase 2 评审已标注为临时护栏)。生产级 agent 把"边界"拆成两层、叠加(defense-in-depth):

|               | **权限闸门**(命令**该不该**跑)                               | **沙箱**(命令跑起来**能碰什么**)               |
| ------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| 时机          | 执行**前**决策                                               | 执行**中**由 OS 强制                           |
| 形态          | allow/deny/ask 规则、人工审批                                | 文件系统 + 网络边界                            |
| 我们的件      | `PermissionPolicy` + `ApprovalHandler`(主设计 §5/§6,Phase 3) | **`Sandbox` 策略(本文)**                       |
| 绕过模型选择? | 否(基于命令串判断)                                           | **是**(OS 对运行中进程强制,与模型选了什么无关) |

一句话:_"The sandbox isn't the constraint. It's the permission slip."_ 两者必须都有——只有闸门,被放行的命令仍能读 `~/.ssh`、外联;只有沙箱,危险但"在边界内"的操作不会被叫停审批。

**不再加固黑名单**:它是输的方向,本设计用它替代品。

## 2. `Sandbox` —— 第 9 个可插拔策略(在 `@lite-agent/core`)

与现有 8 个策略同构(主设计 §5)。核心只定义**接口 + noop 默认**,不引入任何实现依赖,保持精瘦:

```ts
// packages/core/src/strategies.ts  (Phase 3 新增)
export interface SandboxWrapOptions {
  readonly cwd: string; // 命令的工作目录(默认可写边界)
}

// 9. 沙箱 —— 把一条 shell 命令包成"在 OS 边界内执行"的等价命令
export interface Sandbox {
  readonly id: string;
  wrap(command: string, opts: SandboxWrapOptions): Promise<string> | string;
  dispose?(): Promise<void> | void; // 可选:释放代理/临时资源(进程退出时)
}

// 默认:不设边界,命令原样返回 —— 保证精瘦/跨平台/本地小模型零负担,行为同今天
export function noopSandbox(): Sandbox {
  return { id: "noop", wrap: (command) => command };
}
```

设计要点:

- `wrap` 是**纯命令字符串变换**(`cmd → wrapped cmd`),`bash` 工具 `execSync(wrapped)` 即可,不改变工具的执行方式。
- 允许 `Promise`(适配器需懒初始化代理/沙箱);noop 同步返回。
- 进程网络过滤的代理、临时目录等生命周期由**适配器内部**管理,接口只暴露 `wrap`/`dispose`,核心不感知。
- 它是"同角色只有一个实现"的可替换部件 → 判定为 **Strategy**(符合主设计 §6 的"策略 vs 中间件 vs 事件"硬约束),不是中间件。

## 3. 接入点

### 3.1 `ToolContext` 增加 `sandbox`(core)

与 `approval`/`input` 同列,kernel 默认注入 `noopSandbox()`,工具无需判空:

```ts
export interface ToolContext {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  emit(ev: AgentEvent): void;
  readonly approval?: ApprovalHandler;
  readonly input?: InputHandler;
  readonly sandbox: Sandbox; // ← Phase 3 新增,默认 noopSandbox()
}
```

### 3.2 `bashTool` 消费它(`lite-agent`)

唯一改动:`execSync` 前 `wrap`。default(noop)下 `wrapped === command`,**完全保持现有行为**:

```ts
execute: async ({ command }, ctx) => {
  // 危险子串黑名单可保留为"早失败"提示,但不再是安全边界
  const wrapped = await ctx.sandbox.wrap(command, { cwd: workdir });
  const out = execSync(wrapped, {
    cwd: workdir,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 50_000_000,
  });
  return out.trim() || "(no output)";
};
```

### 3.3 配置入口(`createAgent` / `createLiteAgent`)

新增可选 `sandbox?: Sandbox`,默认 `noopSandbox()`,kernel 透传进 `ToolContext`:

```ts
createLiteAgent({
  model,
  workdir,
  sandbox: sandboxRuntime({
    /* 见 §4 */
  }), // opt-in;不传 = noop
});
```

## 4. `sandboxRuntime()` 适配器 —— 独立包 `@lite-agent/sandbox-anthropic`

封装 Anthropic 官方 [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)(Claude Code `/sandbox` 同款,OS 级、无容器)。**单独成包**,把实验性依赖挡在 core/sdk 之外(与 `@lite-agent/provider` 平行):

```ts
// packages/sandbox-anthropic/src/index.ts
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { Sandbox } from "@lite-agent/core";

export interface SandboxRuntimeOptions {
  allowedDomains?: string[]; // 网络白名单(空 = 无外联)
  deniedDomains?: string[];
  allowWrite?: string[]; // 写白名单(默认仅 cwd + 临时目录)
  denyRead?: string[]; // 默认建议: ["~/.ssh", "~/.aws", "~/.config/gcloud"]
  denyWrite?: string[]; // 例: [".env"]
}

export function sandboxRuntime(opts: SandboxRuntimeOptions = {}): Sandbox {
  let ready: Promise<void> | undefined;
  const config: SandboxRuntimeConfig = {
    network: {
      allowedDomains: opts.allowedDomains ?? [],
      deniedDomains: opts.deniedDomains ?? [],
    },
    filesystem: {
      allowWrite: opts.allowWrite ?? ["."],
      denyRead: opts.denyRead ?? ["~/.ssh", "~/.aws"],
      denyWrite: opts.denyWrite,
    },
  };
  return {
    id: "sandbox-runtime",
    async wrap(command) {
      ready ??= SandboxManager.initialize(config); // 懒初始化一次(含网络代理)
      await ready;
      return SandboxManager.wrapWithSandbox(command);
    },
    dispose: () => SandboxManager.reset(),
  };
}
```

底层:`macOS = Seatbelt(sandbox-exec)`,`Linux/WSL2 = bubblewrap + socat + ripgrep`;边界由 OS 强制,**子进程一并继承**。`opts.cwd` 已是默认可写根(`allowWrite: ["."]`),其余按白名单放行。

## 5. 端到端示例

```ts
import { createLiteAgent } from "lite-agent";
import { anthropic } from "@lite-agent/provider";
import { sandboxRuntime } from "@lite-agent/sandbox-anthropic";

const agent = createLiteAgent({
  model: anthropic(),
  workdir: process.cwd(),
  skillsDir: "skills",
  // 闸门(Phase 3)
  // permission: policy({ allow: ["read_file"], ask: ["bash", "write_file"], deny: ["rm *"] }),
  // 边界(本文)
  sandbox: sandboxRuntime({
    allowedDomains: ["api.github.com", "registry.npmjs.org"],
    denyRead: ["~/.ssh", "~/.aws"],
    denyWrite: [".env"],
  }),
});
```

`bash` 跑 `curl evil.com` → 域名不在白名单被拦;`cat ~/.ssh/id_rsa` → 读被拒;`rm -rf ~/project-outside` → 写越界被 OS 拒。无需依赖模型自觉。

## 6. 取舍与边界(必须写明)

- **`@anthropic-ai/sandbox-runtime` 是 "Beta Research Preview"**:API 会变,**不支持原生 Windows**(WSL2 可)。因此**必须做成可插拔、默认 noop**:无 bubblewrap / Windows / 本地裸跑环境自动降级为"无边界",不阻断主流程。生产强约束场景由 host 决定是否 `failIfUnavailable`(可在适配器加一个"初始化失败即抛"的开关)。
- **久经考验的是底层原语**(bubblewrap/Seatbelt),这个库只是薄封装;若要更稳可再写一个直接调 `bwrap`/`sandbox-exec` 的 `Sandbox` 实现——同一接口,随时替换。
- **网络过滤不做 TLS 解密**:基于客户端声明的 hostname 放行,存在 domain-fronting 等绕过面;放行 `github.com` 这类宽域名即开了外泄通道。威胁模型更强时需自定义 MITM 代理(超出本设计)。
- **非目标:跑完全不可信代码**。OS 级沙箱是给"可信 agent 加护栏",不是隔离恶意代码。后者应上 microVM(**E2B** / **microsandbox**)——另立一个 `Sandbox` 适配器按需接入,**不进** core,以免破坏"精瘦 + 本地"。

## 7. 测试策略

- **接口/默认**(core):`noopSandbox().wrap(cmd) === cmd`;kernel 默认把 `noopSandbox` 注入 `ToolContext`。
- **bashTool 集成**(sdk):注入一个**假 `Sandbox`**(`wrap = c => `FAKE(${c})``),断言 `execSync` 收到被包裹后的命令 → 证明接入点正确,**不打真实 OS 沙箱、不依赖 bubblewrap**。
- **适配器**(sandbox-anthropic):`SandboxRuntimeOptions → SandboxRuntimeConfig` 的纯映射单测(域名/读写白名单/默认 denyRead);`wrap` 只 mock `SandboxManager` 验证"懒初始化一次 + 调用 `wrapWithSandbox`"。真实 OS 边界靠手动/CI 在 macOS+Linux 验。
- 不为实验性外部库写端到端网络/文件越权用例(脆弱、平台相关),改为文档化手动验收清单。

## 8. 开放问题(实现期再定)

- `Sandbox.wrap` 是否需要 `denyRead` 的默认值由适配器给,还是强制 host 显式声明(避免"以为安全其实没拦凭据")?倾向:适配器给安全默认(`~/.ssh`、`~/.aws`),host 可覆盖。
- 适配器初始化失败(缺 bubblewrap / Windows)时:静默降级 noop(默认)vs 抛错——加一个 `requireSandbox: boolean` 开关。
- 是否把 `Sandbox` 也用于 `subagent` / 其他 spawn 进程的工具(接口已通用,留待这些工具落地时接)。
- 与 `PermissionPolicy` 的协同顺序:闸门在 `wrapToolCall`(执行前),沙箱在 `Tool.execute` 内(执行中),天然分层,无需额外编排。
