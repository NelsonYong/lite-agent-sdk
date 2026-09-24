import { Client, StreamableHTTPClientTransport, fromJsonSchema } from "@modelcontextprotocol/client";
import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { abortable, toToolSpec } from "@lite-agent/core";
import type { Tool, ToolContext, ToolOutput, Sandbox } from "@lite-agent/core";
import { mcpFetch } from "./http";
import type { McpDefinition } from "./config";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
const MAX_BYTES = 4 * 1024 * 1024;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export interface McpConnection {
  tools: Tool[];
  stale: boolean;
  close(): Promise<void>;
}

/** Projection is provider-neutral. Binary and large responses stay in the session archive. */
async function project(result: { content?: unknown; structuredContent?: unknown; isError?: boolean }, ctx: ToolContext): Promise<ToolOutput> {
  const content = JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
  const blocks = Array.isArray(result.content) ? result.content : [];
  const rich = blocks.some((block) => block.type !== "text" && block.type !== "resource_link");
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("MCP result exceeds 4 MiB; request a smaller result");
  if (rich || Buffer.byteLength(content) > 16 * 1024) {
    if (!ctx.archive) return { content: "MCP response requires a session archive; request a smaller text result.", isError: true };
    const saved = await ctx.archive.put(content, { kind: "mcp-result", sessionId: ctx.sessionId, toolCallId: ctx.call?.id });
    return { content: `MCP result archived: ${saved.ref}. Contains text, structured data and/or media. Read with context({ref: "${saved.ref}", offset: 0}). External resource URIs are not local file paths.`, isError: result.isError };
  }
  return { content, isError: result.isError };
}

export async function connectMcp(definition: McpDefinition, workdir: string, sandbox: Sandbox | undefined, signal: AbortSignal): Promise<McpConnection> {
  const { name, config } = definition;
  const connection: McpConnection = { tools: [], stale: false, close: () => client.close() };
  const client = new Client({ name: "lite-agent", version: "0.16.0" }, {
    versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION }, probe: { timeoutMs: config.timeoutMs, maxRetries: 0 } },
    capabilities: {}, inputRequired: { autoFulfill: false }, listMaxPages: 16,
    listChanged: { tools: { autoRefresh: false, onChanged: () => { connection.stale = true; } } },
  });
  client.onclose = () => { connection.stale = true; };
  client.onerror = () => { connection.stale = true; };
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
  try {
    bounded.throwIfAborted();
    let transport;
    if (config.type === "stdio") {
      let command = config.command;
      let args = config.args;
      if (sandbox) {
        const wrapped = await abortable(Promise.resolve(sandbox.wrap([command, ...args].map(quote).join(" "), { cwd: workdir })), bounded);
        command = "/bin/sh";
        args = ["-c", wrapped];
      }
      bounded.throwIfAborted();
      transport = new StdioClientTransport({ command, args, env: config.env, cwd: workdir, stderr: "pipe", maxBufferSize: MAX_BYTES });
      // Drain without logging potentially secret server stderr.
      transport.stderr?.on("data", () => {});
    } else {
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
        fetch: mcpFetch,
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      });
    }
    await abortable(client.connect(transport, { signal: bounded, timeout: config.timeoutMs }), bounded);
    const catalog = await abortable(client.listTools(undefined, { signal: bounded, timeout: config.timeoutMs, maxTotalTimeout: config.timeoutMs }), bounded);
    if (catalog.tools.length > 128 || Buffer.byteLength(JSON.stringify(catalog)) > 512 * 1024) throw new Error("MCP tool catalog exceeds limits");
    const names = new Set<string>();
    connection.tools = catalog.tools.map((remote): Tool => {
      const toolName = `mcp__${name}__${remote.name}`;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(toolName) || names.has(toolName)) throw new Error("Invalid or duplicate MCP tool name");
      names.add(toolName);
      const tool: Tool = {
        name: toolName, description: remote.description ?? remote.name,
        schema: fromJsonSchema(remote.inputSchema as JsonSchemaType),
        // Server annotations do not establish local safety properties.
        security: { network: "unrestricted", filesystem: "unrestricted", sideEffects: "external" },
        async execute(input, ctx) {
          if (connection.stale) return { content: `MCP '${name}' catalog or connection changed; unregister and register again while idle.`, isError: true };
          try {
            const result = await client.callTool({ name: remote.name, arguments: input as Record<string, unknown> }, {
              signal: ctx.signal, timeout: config.timeoutMs, maxTotalTimeout: config.timeoutMs,
              onprogress: (progress) => ctx.emit({ type: "tool_progress", id: ctx.call?.id ?? "", name: toolName,
                progress: progress.progress, total: progress.total, message: progress.message?.slice(0, 1024) }),
            });
            return await project(result, ctx);
          } catch {
            // Remote errors may echo authorization headers, URLs, arguments or environment values.
            return { content: `MCP '${name}' call failed or was cancelled; execution outcome may be unknown. Do not automatically retry side effects.`, isError: true };
          }
        },
      };
      toToolSpec(tool);
      return tool;
    });
    if (connection.stale) throw new Error("MCP catalog changed during discovery");
    return connection;
  } catch {
    await client.close().catch(() => {});
    throw new Error(`MCP '${name}' connection or discovery failed (check endpoint, protocol ${MCP_PROTOCOL_VERSION}, schema and timeout)`);
  }
}
