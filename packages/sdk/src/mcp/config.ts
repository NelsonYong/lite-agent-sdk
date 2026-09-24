import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const timeout = z.number().int().min(1).max(300_000).default(30_000);
const text = z.string().min(1).refine((value) => !value.includes("\0"));
const common = { timeoutMs: timeout };
const server = z.union([
  z.object({ ...common, type: z.literal("stdio").default("stdio"), command: text,
    args: z.array(z.string().refine((value) => !value.includes("\0"))).max(256).default([]),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().refine((value) => !value.includes("\0"))).optional(),
  }).strict(),
  z.object({ ...common, type: z.literal("http"), url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
  }).strict(),
]);
export type McpServerConfig = z.input<typeof server>;
export type ResolvedMcpConfig = z.output<typeof server>;
export type McpSource = "global" | "project" | "constructor" | "instance";
export interface McpDefinition { name: string; config: ResolvedMcpConfig; source: McpSource }

export function parseMcpConfig(name: string, input: McpServerConfig): ResolvedMcpConfig {
  if (!/^[a-zA-Z0-9_-]{1,24}$/.test(name) || name.includes("__"))
    throw new Error("MCP server name must be 1-24 letters, digits, underscores or hyphens, without '__'");
  const parsed = server.safeParse(input);
  // Never echo credential-bearing invalid values or Zod's full error into logs.
  if (!parsed.success) throw new Error(`Invalid MCP configuration for '${name}'`);
  if (parsed.data.type === "http") {
    const url = new URL(parsed.data.url);
    if (url.username || url.password || url.hash ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
      throw new Error(`MCP '${name}' requires HTTPS (HTTP is allowed on loopback only), without URL credentials or fragments`);
    let headers: Headers;
    try { headers = new Headers(parsed.data.headers); }
    catch { throw new Error(`MCP '${name}' contains an invalid HTTP header`); }
    for (const key of headers.keys()) {
      if (["host", "connection", "content-length", "mcp-protocol-version", "mcp-session-id"].includes(key))
        throw new Error(`MCP '${name}' contains a reserved HTTP header`);
    }
  }
  return parsed.data;
}

export function loadMcpDefinitions(home: string, workdir: string, strict: boolean, configured: Record<string, McpServerConfig> = {}): McpDefinition[] {
  const definitions = new Map<string, McpDefinition>();
  const merge = (entries: Record<string, McpServerConfig>, source: McpSource) => {
    for (const [name, input] of Object.entries(entries)) {
      const config = parseMcpConfig(name, input);
      const prior = definitions.get(name);
      if (prior && !isDeepStrictEqual(prior.config, config)) throw new Error(`Conflicting MCP server '${name}' in ${prior.source} and ${source}`);
      if (!prior) definitions.set(name, { name, config, source });
    }
    if (definitions.size > 32) throw new Error("MCP configuration exceeds 32 servers");
  };
  if (!strict) for (const [source, file] of [
    ["global", join(home, "mcps.json")], ["project", join(workdir, ".lite-agent", "mcps.json")],
  ] as const) {
    try {
      if (statSync(file).size > 256 * 1024) throw new Error("too large");
      const data = z.object({ mcpServers: z.record(z.string(), z.unknown()) }).strict().parse(JSON.parse(readFileSync(file, "utf8")));
      merge(data.mcpServers as Record<string, McpServerConfig>, source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Invalid or conflicting MCP configuration in ${source} mcps.json`);
    }
  }
  merge(configured, "constructor");
  return [...definitions.values()];
}
