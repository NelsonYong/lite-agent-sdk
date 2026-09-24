import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { ClientCredentialsProvider } from "@modelcontextprotocol/client";
import type { OAuthDiscoveryState, StoredOAuthTokens, StoredOAuthClientInformation } from "@modelcontextprotocol/client";
import { fakeProvider, policy, textBlock } from "@lite-agent/core";
import type { AgentEvent } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import type { LiteAgent } from "../src/liteAgent";
import type { McpOAuthConfig, McpOAuthProvider } from "../src/mcp/oauth";

const resource = "https://mcp.test/mcp";
const issuer = "https://login.test";
const redirectUrl = "http://127.0.0.1:8123/callback";
const roots: string[] = [];
const agents: LiteAgent[] = [];
const handlers: ReturnType<typeof createMcpHandler>[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  await Promise.all(handlers.splice(0).map((handler) => handler.close()));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
class Provider implements McpOAuthProvider {
  readonly redirectUrl = redirectUrl;
  readonly clientMetadata = { redirect_uris: [redirectUrl], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
  #tokens?: StoredOAuthTokens;
  #discovery?: OAuthDiscoveryState;
  #verifier = "";
  #client: StoredOAuthClientInformation | undefined = { client_id: "fixture-client", issuer };
  tokens() { return this.#tokens; }
  saveTokens(tokens: StoredOAuthTokens) { this.#tokens = tokens; }
  clientInformation() { return this.#client; }
  saveClientInformation(info: StoredOAuthClientInformation) { this.#client = info; }
  saveCodeVerifier(verifier: string) { this.#verifier = verifier; }
  codeVerifier() { return this.#verifier; }
  discoveryState() { return this.#discovery; }
  saveDiscoveryState(state: OAuthDiscoveryState) { this.#discovery = state; }
}
function fixture() {
  const provider = new Provider();
  const state = { acceptedToken: "access-1", issued: 0, calls: 0, refreshes: 0, exchanges: 0, challenge: "", code: "fixture-code", tokenOrigin: issuer, scopeDenied: false, refreshError: false, machine: false };
  const handler = createMcpHandler(() => {
    const s = new McpServer({ name: "oauth-fixture", version: "1" });
    s.registerTool("echo", {}, async () => { state.calls++; return { content: [{ type: "text", text: "authenticated" }] }; });
    return s;
  }, { legacy: "reject" }); handlers.push(handler);
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const req = new Request(url, init);
    if (req.url === resource) {
      if (req.headers.get("authorization") !== `Bearer ${state.acceptedToken}`)
        return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource", scope="tools"` } });
      if (state.scopeDenied && req.method === "POST" && ((await req.clone().json()) as { method: string }).method === "tools/call")
        return new Response(null, { status: 403, headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="admin"' } });
      return handler.fetch(req);
    }
    if (req.url === "https://mcp.test/.well-known/oauth-protected-resource")
      return Response.json({ resource, authorization_servers: [issuer], scopes_supported: ["tools"] });
    if (req.url === `${issuer}/.well-known/oauth-authorization-server`)
      return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${state.tokenOrigin}/token`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"], token_endpoint_auth_methods_supported: state.machine ? ["client_secret_basic"] : ["none"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true });
    if (req.url === `${issuer}/token`) {
      const form = new URLSearchParams(await req.text());
      expect(form.get("resource")).toBe(resource);
      if (form.get("grant_type") === "authorization_code") {
        state.exchanges++;
        expect(form.get("code")).toBe(state.code);
        expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(state.challenge);
      } else if (form.get("grant_type") === "client_credentials") {
        expect(req.headers.get("authorization")).toBe(`Basic ${Buffer.from("machine:synthetic-secret").toString("base64")}`);
      } else {
        expect(form.get("grant_type")).toBe("refresh_token"); state.refreshes++;
        if (state.refreshError) return Response.json({ error: "invalid_grant", error_description: "SECRET_FROM_REMOTE" }, { status: 400 });
      }
      state.issued++;
      state.acceptedToken = `access-${state.issued}`;
      return Response.json({ access_token: state.acceptedToken, refresh_token: `refresh-${state.issued}`, token_type: "Bearer", expires_in: 3600, scope: "tools" });
    }
    throw new Error("Unexpected fixture request");
  });
  vi.stubGlobal("fetch", fetchMock);
  const authorize = vi.fn(async (url: URL) => {
    expect(url.origin).toBe(issuer);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    state.challenge = url.searchParams.get("code_challenge")!;
    const callback = new URL(redirectUrl);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("code", state.code);
    callback.searchParams.set("iss", issuer);
    return callback;
  });
  const oauth: McpOAuthConfig = { serverUrl: resource, provider, allowedOrigins: [issuer], authorize };
  return { provider, oauth, state, fetchMock, authorize };
}
function agent(oauth: McpOAuthConfig, extra: Partial<Parameters<typeof createLiteAgent>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "mcp-oauth-")); roots.push(root);
  const a = createLiteAgent({ workdir: root, home: join(root, "home"), cleanup: false, sessions: false, tasks: false, agents: false, hookFiles: false, context: false,
    strictMcpConfig: true, permission: policy({ default: "allow" }), mcpOAuth: { docs: oauth },
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", name: "mcp__docs__echo", id: "call", input: {} }] } },
      { message: { role: "assistant", content: [textBlock("done")] } },
    ]), ...extra });
  agents.push(a); return a;
}
const http = { type: "http" as const, url: resource };

test("official OAuth discovery, PKCE exchange and authenticated MCP calls use host storage without exposing tokens", async () => {
  const f = fixture(); const a = agent(f.oauth); const events: AgentEvent[] = [];
  a.subscribe(({ event }) => events.push(event));
  await a.mcp.register("docs", http);
  await a.send("go");
  expect(f.state.exchanges).toBe(1); expect(f.authorize).toHaveBeenCalledOnce(); expect(f.state.calls).toBe(1);
  expect(f.provider.tokens()).toMatchObject({ access_token: "access-1", issuer });
  expect(JSON.stringify([events, a.mcp.list()])).not.toMatch(/access-1|refresh-1|fixture-code|code_verifier/);
  await a.close(); expect(f.provider.tokens()?.access_token).toBe("access-1");
});

test("refreshes rejected tokens through the official OAuth flow without opening another login", async () => {
  const f = fixture(); const a = agent(f.oauth);
  await a.mcp.register("docs", http);
  f.state.acceptedToken = "expired";
  await a.send("go");
  expect(f.state.refreshes).toBe(1); expect(f.state.calls).toBe(1); expect(f.authorize).toHaveBeenCalledOnce();
  expect(f.provider.tokens()?.access_token).toBe("access-2");
});

test.each(["state", "redirect", "issuer", "duplicate", "denied"])("rejects invalid OAuth callback (%s) before code redemption", async (kind) => {
  const f = fixture(); const original = f.oauth.authorize!;
  f.oauth.authorize = async (url, context) => {
    const callback = new URL(await original(url, context));
    if (kind === "state") callback.searchParams.set("state", "wrong");
    if (kind === "redirect") callback.pathname = "/wrong";
    if (kind === "issuer") callback.searchParams.set("iss", "https://evil.test");
    if (kind === "duplicate") callback.searchParams.append("code", "replay");
    if (kind === "denied") callback.searchParams.set("error", "access_denied");
    return callback;
  };
  const a = agent(f.oauth);
  await expect(a.mcp.register("docs", http)).rejects.toThrow(/discovery failed/);
  expect(f.state.exchanges).toBe(0); expect(f.provider.tokens()).toBeUndefined(); expect(a.mcp.list()).toEqual([]);
});

test("refuses mismatched resources, untrusted token endpoints and static header mixing", async () => {
  const f = fixture(); const a = agent(f.oauth);
  await expect(a.mcp.register("docs", { ...http, url: "https://evil.test/mcp" })).rejects.toThrow(/different MCP URL/);
  expect(f.fetchMock).not.toHaveBeenCalled();
  await expect(a.mcp.register("docs", { ...http, headers: { Authorization: "secret" } })).rejects.toThrow(/static headers/);
  f.state.tokenOrigin = "https://evil.test";
  await expect(a.mcp.register("docs", http)).rejects.toThrow(/discovery failed/);
  expect(f.fetchMock.mock.calls.some(([url]) => new URL(url).origin === "https://evil.test")).toBe(false);
});

test("connection denial prevents OAuth network, storage and host authorization", async () => {
  const f = fixture(); const tokens = vi.spyOn(f.provider, "tokens");
  const a = agent(f.oauth, { permission: policy({ default: "deny" }) });
  await expect(a.mcp.register("docs", http)).rejects.toThrow(/denied/);
  expect(f.fetchMock).not.toHaveBeenCalled(); expect(tokens).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
});

test("closing during login aborts the host callback and prevents late token exchange", async () => {
  const f = fixture(); let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
  let callbackSignal!: AbortSignal;
  f.oauth.authorize = async (_url, { signal }) => { callbackSignal = signal; started(); return new Promise(() => {}); };
  const a = agent(f.oauth); const registration = a.mcp.register("docs", http);
  const rejected = expect(registration).rejects.toThrow(/discovery failed/);
  await ready; await a.close(); await rejected;
  expect(callbackSignal.aborted).toBe(true); expect(f.state.exchanges).toBe(0);
});

test("scope escalation fails without automatic login or side-effect execution", async () => {
  const f = fixture(); const a = agent(f.oauth);
  await a.mcp.register("docs", http); f.state.scopeDenied = true;
  await a.send("go");
  expect(f.authorize).toHaveBeenCalledOnce(); expect(f.state.calls).toBe(0); expect(f.state.refreshes).toBe(0);
});

test("remote OAuth error descriptions are removed before official SDK diagnostics", async () => {
  const f = fixture(); const warn = vi.spyOn(console, "warn").mockImplementation(() => {}); const a = agent(f.oauth);
  await a.mcp.register("docs", http); f.state.acceptedToken = "expired"; f.state.refreshError = true;
  await a.send("go");
  expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET_FROM_REMOTE");
  expect(f.authorize).toHaveBeenCalledOnce(); expect(f.state.calls).toBe(0);
});

test("concurrent 401s share a refresh without serializing successful tool execution", async () => {
  const f = fixture(); const a = agent(f.oauth, { model: fakeProvider([
    { message: { role: "assistant", content: ["one", "two", "three"].map((id) => ({ type: "tool_call", name: "mcp__docs__echo", id, input: {} })) } },
    { message: { role: "assistant", content: [textBlock("done")] } },
  ]) });
  await a.mcp.register("docs", http); f.state.acceptedToken = "expired";
  await a.send("go");
  expect(f.state.calls).toBe(3); expect(f.state.refreshes).toBe(1); expect(f.authorize).toHaveBeenCalledOnce();
});

test("provider ownership prevents concurrent PKCE reuse and stored tokens survive reconnect", async () => {
  const f = fixture(); const first = agent(f.oauth); const second = agent(f.oauth);
  await first.mcp.register("docs", http);
  await expect(second.mcp.register("docs", http)).rejects.toThrow(/another active connection/);
  await first.close();
  await second.mcp.register("docs", http); await second.send("go");
  expect(f.authorize).toHaveBeenCalledOnce(); expect(f.state.calls).toBe(1);
});

test("official client-credentials provider supports machine authentication without an interactive callback", async () => {
  const f = fixture(); f.state.machine = true;
  const provider = new ClientCredentialsProvider({ clientId: "machine", clientSecret: "synthetic-secret", expectedIssuer: issuer });
  const a = agent({ ...f.oauth, provider, authorize: undefined });
  await a.mcp.register("docs", http); await a.send("go");
  expect(f.state.calls).toBe(1); expect(f.state.issued).toBe(1); expect(f.authorize).not.toHaveBeenCalled();
});

test("file-discovered HTTP servers receive OAuth only from the URL-bound host configuration", async () => {
  const f = fixture(); const root = mkdtempSync(join(tmpdir(), "mcp-oauth-file-")); roots.push(root);
  mkdirSync(join(root, ".lite-agent"));
  writeFileSync(join(root, ".lite-agent", "mcps.json"), JSON.stringify({ mcpServers: { docs: http } }));
  const a = agent(f.oauth, { workdir: root, strictMcpConfig: false });
  await a.send("go");
  expect(f.state.calls).toBe(1); expect(a.mcp.list()[0]?.source).toBe("project");
});

test("authorization timeout fails registration and releases the provider for a later attempt", async () => {
  const f = fixture(); const original = f.oauth.authorize;
  const a = agent({ ...f.oauth, timeoutMs: 75, authorize: () => new Promise(() => {}) });
  await expect(a.mcp.register("docs", http)).rejects.toThrow(/discovery failed/);
  const next = agent({ ...f.oauth, authorize: original });
  await next.mcp.register("docs", http);
  expect(next.mcp.list()[0]?.status).toBe("ready");
});
