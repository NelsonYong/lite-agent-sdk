import { randomUUID } from "node:crypto";
import { permission, defaultRedactor, abortable } from "@lite-agent/core";
import type { Tool, ToolCallContext } from "@lite-agent/core";
import type { CreateLiteAgentConfig } from "../liteAgent";
import { loadMcpDefinitions, parseMcpConfig } from "./config";
import type { McpDefinition, McpServerConfig, McpSource } from "./config";
import { connectMcp } from "./connection";
import type { McpConnection } from "./connection";

export interface McpServerStatus {
  name: string;
  source: McpSource;
  status: "configured" | "connecting" | "ready" | "stale" | "error";
  toolNames: string[];
  error?: string;
}
export interface McpApi {
  register(name: string, config: McpServerConfig): Promise<void>;
  unregister(name: string): Promise<void>;
  list(): McpServerStatus[];
}
type Scope = Pick<ToolCallContext, "sessionId" | "signal" | "emit" | "recordSessionEvent">;
type Entry = McpDefinition & { state: McpServerStatus["status"]; connection?: McpConnection };

/** Root-owned connections; children borrow catalogs and run leases, never ownership. */
export class McpRegistry {
  private entries = new Map<string, Entry>();
  private active = 0;
  private mutating = false;
  private pending?: Promise<void>;
  private closed = false;
  private lifetime = new AbortController();
  private closePromise?: Promise<void>;

  constructor(private cfg: CreateLiteAgentConfig, home: string) {
    if (cfg.tools?.some((tool) => tool.name.startsWith("mcp__") || tool.name === "mcp_connect"))
      throw new Error("Custom tools cannot use the reserved MCP namespace");
    for (const definition of loadMcpDefinitions(home, cfg.workdir, cfg.strictMcpConfig === true, cfg.mcpServers)) {
      this.validateTransport(definition.config);
      this.entries.set(definition.name, { ...definition, state: "configured" });
    }
  }

  private validateTransport(config: McpServerConfig) {
    if (this.cfg.mcpTransports && !this.cfg.mcpTransports.includes(config.type ?? "stdio"))
      throw new Error("MCP transport is disabled by the host");
  }
  list(): McpServerStatus[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.name, source: entry.source,
      status: entry.connection?.stale ? "stale" : entry.state,
      toolNames: entry.connection?.tools.map((tool) => tool.name) ?? [],
      ...(entry.state === "error" ? { error: "Connection or discovery failed; unregister and register again to retry" } : {}),
    }));
  }
  tools(): Tool[] { return [...this.entries.values()].flatMap((entry) => entry.connection?.tools ?? []); }
  enterRun(): () => void {
    if (this.closed) throw new Error("MCP registry is closed");
    if (this.mutating) throw new Error("MCP registry is busy");
    this.active++;
    return () => { this.active--; };
  }
  private async connect(entry: Entry, scope: Scope): Promise<McpConnection> {
    const signal = AbortSignal.any([scope.signal, this.lifetime.signal]);
    signal.throwIfAborted();
    entry.state = "connecting";
    const safe = this.cfg.redact ?? defaultRedactor;
    const input = entry.config.type === "stdio"
      ? { server: entry.name, source: entry.source, type: "stdio", command: entry.config.command, args: safe(entry.config.args), envKeys: Object.keys(entry.config.env ?? {}) }
      : { server: entry.name, source: entry.source, type: "http", origin: new URL(entry.config.url).origin, headerKeys: Object.keys(entry.config.headers ?? {}) };
    let connection: McpConnection | undefined;
    const ctx: ToolCallContext = { ...scope, signal, turn: 0, messages: [], state: new Map(),
      call: { id: randomUUID(), name: "mcp_connect", input } };
    try {
      const gate = permission(this.cfg.permission!, this.cfg.onApproval, { redact: safe, audit: this.cfg.permissionAudit });
      const result = await gate.wrapToolCall!(ctx, async () => {
        connection = await connectMcp(entry, this.cfg.workdir, this.cfg.sandbox, signal);
        return { id: ctx.call.id, name: ctx.call.name, content: "MCP connected" };
      });
      if (result.isError || !connection) throw new Error(`MCP '${entry.name}' connection denied`);
      signal.throwIfAborted();
      return connection;
    } catch (error) {
      entry.state = "error";
      await connection?.close().catch(() => {});
      throw error;
    }
  }
  async prepare(scope: Scope): Promise<void> {
    if (this.closed) throw new Error("MCP registry is closed");
    if (!this.pending) {
      const entries = [...this.entries.values()].filter((entry) => entry.state === "configured");
      if (entries.length) {
        this.pending = (async () => {
          const connected: Array<[Entry, McpConnection]> = [];
          try {
            for (const entry of entries) connected.push([entry, await this.connect(entry, scope)]);
            for (const [entry, connection] of connected) { entry.connection = connection; entry.state = "ready"; }
          } catch (error) {
            await Promise.allSettled(connected.map(([, connection]) => connection.close()));
            for (const entry of entries) entry.state = "error";
            throw error;
          }
        })();
        const work = this.pending;
        const clear = () => { if (this.pending === work) this.pending = undefined; };
        void work.then(clear, clear);
      }
    }
    const pending = this.pending;
    if (pending) await abortable(pending, scope.signal);
    scope.signal.throwIfAborted();
    if (this.list().some((entry) => entry.status === "error" || entry.status === "stale"))
      throw new Error("MCP connection or catalog unavailable; unregister and register the affected server while idle");
  }
  private async mutation(run: () => Promise<void>): Promise<void> {
    if (this.closed) throw new Error("MCP registry is closed");
    if (this.active || this.mutating || this.pending) throw new Error("MCP registry is busy; wait for runs and related work to finish");
    this.mutating = true;
    try { this.pending = run(); await this.pending; }
    finally { this.pending = undefined; this.mutating = false; }
  }
  register(name: string, config: McpServerConfig, scope: Scope): Promise<void> {
    return this.mutation(async () => {
      if (this.entries.has(name)) throw new Error(`MCP '${name}' is already registered`);
      if (this.entries.size >= 32) throw new Error("MCP registry exceeds 32 servers");
      const parsed = parseMcpConfig(name, config);
      this.validateTransport(parsed);
      const entry: Entry = { name, config: parsed, source: "instance", state: "configured" };
      const connection = await this.connect(entry, scope);
      entry.connection = connection; entry.state = "ready";
      this.entries.set(name, entry);
    });
  }
  unregister(name: string): Promise<void> {
    return this.mutation(async () => {
      const entry = this.entries.get(name);
      if (!entry) throw new Error(`Unknown MCP server '${name}'`);
      await entry.connection?.close();
      this.entries.delete(name);
    });
  }
  close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.closePromise ??= (async () => {
      await this.pending?.catch(() => {});
      const closed = await Promise.allSettled([...this.entries.values()].map((entry) => entry.connection?.close()));
      this.entries.clear();
      const errors = closed.filter((result) => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Failed to close MCP connections");
    })();
    return this.closePromise;
  }
}
