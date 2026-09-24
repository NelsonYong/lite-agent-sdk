# MCP servers

Since `@lite-agent/sdk` 0.16.0, MCP tools share the existing permission, hook, concurrency, cancellation and archive pipeline. The adapter uses official `@modelcontextprotocol/client` 2.1.0 and pins **MCP 2026-07-28**. Node.js >=20 is required. Only stdio and Streamable HTTP are supported; there is no legacy SSE transport or protocol fallback.

## File configuration

Use `<workdir>/.lite-agent/mcps.json` for a project and `<home>/mcps.json` for personal servers (default `~/.lite-agent/mcps.json`):

```json
{
  "mcpServers": {
    "docs": { "type": "http", "url": "https://docs.example.com/mcp" },
    "files": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"],
      "env": { "LOG_LEVEL": "warn" }
    }
  }
}
```

The `mcpServers` shape follows Claude conventions; **mcps.json** is the lite-agent filename. Claude settings and root `.mcp.json` files are not read. Omitted `type` means stdio; HTTP requires an explicit type. Variable interpolation is not supported. Supply credentials from your host through constructor/instance configuration instead of committing them to project files.

Construction reads and validates configuration without starting a server. The first `run()` / `send()` authorizes, connects and validates the catalog before calling the model. No configuration means no MCP connections.

```ts
import { createLiteAgent } from '@lite-agent/sdk';
import { openai } from '@lite-agent/provider';

const agent = createLiteAgent({
  workdir: process.cwd(),
  model: openai(),
  modelName: 'your-model',
  onApproval: { request: (call, signal) => requestHostApproval(call, signal) },
});
try {
  console.log((await agent.send('Find the project documentation using docs')).text);
} finally {
  await agent.close();
}
```

Implement `requestHostApproval` in your application; it returns `Promise<'allow' | 'deny'>`. Default permissions ask before connections and MCP calls, and deny without an approval handler. `allowedTools` controls model visibility, not authorization.

## Constructor and instance configuration

Files, `mcpServers` and `agent.mcp` feed one registry:

```ts
const agent = createLiteAgent({
  workdir: process.cwd(), model, onApproval,
  strictMcpConfig: true, // Ignore both configuration files
  mcpServers: { docs: { type: 'http', url: 'https://docs.example.com/mcp' } },
});
try {
  await agent.mcp.register('search', {
    type: 'http', url: 'https://search.example.com/mcp',
    headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
    timeoutMs: 30_000,
  });
  console.log(agent.mcp.list());
  await agent.send('Search the documentation');
  await agent.awaitIdle();
  await agent.mcp.unregister('search');
} finally {
  await agent.close();
}
```

`register()` resolves after authorization, connection, discovery, validation and atomic publication. Failed candidates are closed. `list()` is a local snapshot of name, source, status, tool names and sanitized errors; it does not make requests or expose headers/env. `unregister()` closes the connection without editing files.

Different names merge. Identical normalized declarations deduplicate; conflicting declarations fail instead of overriding endpoints. Repeated instance registration fails. Replace a server by unregistering it first. Files are read once and never hot-loaded.

Only the root may mutate the registry, while it and related work are idle. Mutations inside hooks fail promptly. Children borrow connections but retain narrower tool visibility and permissions. Closing a child does not close root connections. Always close the root to cancel activity and release clients, subscriptions and direct child processes.

## Tool behavior

Names use `mcp__<server>__<tool>`, for example `mcp__docs__search`. Server aliases allow 1–24 letters, digits, underscores or hyphens and cannot contain `__`. Complete names allow the same characters, up to 64 characters. Invalid names, duplicates or schemas reject the candidate registration.

Catalogs are fixed for each run. Server catalog notifications and connection failures mark entries `stale`; unregister/register while idle to rediscover and reauthorize. Schemas are never silently replaced during execution.

Inputs use the official JSON Schema validator. The official client checks declared output schemas. Business `isError` results remain errors. Text, resource links and `structuredContent` (including scalar values) are preserved in a JSON projection. Projections above 16 KiB and media/embedded resources are archived; the model receives a session-scoped `context({ref, offset})` reference. Remote `file://` URIs never grant host filesystem access, and links are not fetched automatically.

Progress arrives live through `run()` or `subscribe()` as `tool_progress`, with `id`, `name`, `progress`, optional `total` and `message`. Existing `tool:start` / `tool:end` hooks cover MCP tools. Calls observe `AbortSignal`. A timeout/disconnect/cancellation can leave the outcome unknown; the SDK does not replay side effects automatically.

Defaults and limits:

| Limit | Value |
| --- | --- |
| Connection/call timeout | 30 seconds; `timeoutMs` accepts 1–300000 ms |
| Servers | 32 |
| Tools per server / discovery pages | 128 / 16 |
| Catalog / configuration file | 512 KiB / 256 KiB |
| stdio message / HTTP response / result projection | 4 MiB |

HTTP bytes are bounded before protocol parsing. Oversized data fails explicitly.

## Security and scope

`mcp_connect` is a separate permission capability from each `mcp__...` tool. File configuration and server annotations do not authorize execution. Server instructions are not injected into the system prompt. Connection authorization remains enforced even when tool permissions use dry-run.

Normal SDK stdio processes use the configured `sandbox`, if present. Without one, approved processes have host privileges. Environment inheritance uses the official transport's safe defaults plus explicit `env`, not the complete host environment. stderr is drained without logging. Keep credentials out of command arguments.

`createLocalAgent()` allows only owned stdio processes under its mandatory OS sandbox and resource limits. It rejects HTTP, including loopback endpoints. SDK home and project `.lite-agent` are denied to sandboxed process reads/writes; SDK session archive tools remain available.

Official 2.1.0 pinned stdio negotiation launches a temporary probe followed by the actual process. Both use the same sandboxed launch command. Server startup should avoid business side effects. The official transport reaps direct children; arbitrary descendants still require host OS isolation.

Remote endpoints require HTTPS, except loopback HTTP on `localhost`, `127.0.0.1` or `[::1]`. URL credentials/fragments, reserved protocol headers and redirects are rejected. Explicit HTTP headers are supported. OAuth login/refresh, externally supplied clients, automatic resources/prompts, sampling, roots, elicitation and automatic `input_required` fulfillment are not exposed in this release.

## Core interface changes

`Tool.schema` accepts Standard Schema validation plus Standard JSON Schema input export. Existing Zod 4 tools work. Generic `Tool` consumers should use `schema['~standard'].validate(input)` instead of assuming Zod `.parse()`. `Tool.execute()` can return a string or `{ content: string, isError?: boolean }`; direct callers must handle both forms.
