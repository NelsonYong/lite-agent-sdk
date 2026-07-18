# Middleware

Middleware is how you add cross-cutting behavior to the kernel without touching it: logging, retries, permission gates, compaction. A middleware is an *added layer* around the turn loop — the kernel folds your layers into the classic onion, so each one sees the call on the way in and the result on the way out. Permissions and compaction in lite-agent are themselves just middleware, which proves the seam: anything they do, your own layer can do too.

## Usage

Pass middleware via `use` in `createAgent`:

```ts
import { createAgent } from "@lite-agent/core";
import type { Middleware } from "@lite-agent/core";

const logging: Middleware = {
  name: "logging",
  async *wrapModelCall(ctx, next) {
    console.time(`turn ${ctx.turn}`);
    yield* next();
    console.timeEnd(`turn ${ctx.turn}`);
  },
};

createAgent({ /* … */, use: [logging] });
```

## The `Middleware` interface

A `Middleware` can implement lifecycle hooks and two wrappers:

```ts
interface Middleware {
  name: string;
  beforeAgent?(ctx: AgentContext): void | Promise<void>;
  afterAgent?(ctx: AgentContext): void | Promise<void>;
  beforeModel?(ctx: AgentContext): void | Promise<void>;
  wrapModelCall?(ctx: AgentContext, next: ModelCall): AsyncIterable<ModelChunk>;
  wrapToolCall?(ctx: ToolCallContext, next: ToolExec): Promise<ToolResult>;
}
```

`AgentContext` is the only handle middleware gets: `sessionId`, mutable `messages`, `turn`, `signal`, `emit`, a shared `state` map, and `recordSessionEvent` for persisting custom facts. No globals.

## The onion model: fold order

`composeModelCall` and `composeToolCall` fold the middleware array around the base call with `reduceRight` — **array order is outer → inner**. Given `use: [a, b]`, a model call flows `a → b → provider → b → a`. `runLifecycle` simply runs each hook in array order.

```
use: [A, B, C]
        │
   A ──► B ──► C ──► base tool/model call
   A ◄── B ◄── C ◄── result
```

The first middleware in the array is the outermost layer — it sees the call first on the way in and last on the way out.

## Built-in middleware

| Middleware | What it does |
| --- | --- |
| `retry()` | Retries transient failures with jittered backoff. |
| `compaction(compactor)` | Runs a `Compactor` in `beforeModel` and swaps in the result, emitting a `compaction` event only when messages actually changed. See [Context compaction](/core/compaction). |
| `reactiveCompaction()` | A `wrapModelCall` safety net: catches a context-overflow rejection, applies `reactiveTrim`, and retries — only if nothing streamed yet. |
| `permission(...)` | The policy gate: `wrapToolCall` asks the `PermissionPolicy` for a verdict before invoking `next()` — `deny` short-circuits the call, `ask` suspends it on the `ApprovalHandler`. |

**Permission is just a middleware.** Nothing about gating is hard-coded in the kernel; you can reorder, replace, or drop any of these layers like any other.

## See also

- [The kernel](/core/kernel) — where hooks fire and wrappers wrap in the loop.
- [Strategies](/core/strategies) — `PermissionPolicy`, `ApprovalHandler`, `Compactor` and friends.
- [Context compaction](/core/compaction) — the compaction middleware and compactor toolkit.
- [Events](/core/events) — what middleware can observe and emit via `ctx.emit`.
