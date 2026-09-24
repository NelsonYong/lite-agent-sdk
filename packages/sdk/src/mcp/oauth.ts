import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { auth, extractWWWAuthenticateParams, OAuthErrorCode } from "@modelcontextprotocol/client";
import type { AuthProvider, OAuthClientProvider } from "@modelcontextprotocol/client";
import { abortable } from "@lite-agent/core";
import { mcpFetch } from "./http";

/** Host-owned storage. Interactive state and redirects are managed by this adapter. */
export type McpOAuthProvider = Omit<OAuthClientProvider, "state" | "redirectToAuthorization" | "dpop"> & { dpop?: never };
export interface McpOAuthConfig {
  /** Exact resource URL this credential provider is allowed to authenticate. */
  serverUrl: string;
  /** Trusted OAuth metadata, registration, token and authorization origins. */
  allowedOrigins: readonly string[];
  provider: McpOAuthProvider;
  /** Open the authorization URL and return the complete callback URL. Never return just a code. */
  authorize?: (url: URL, context: { signal: AbortSignal }) => Promise<string | URL>;
  /** Total initial connection/login deadline; default 180 seconds, maximum 10 minutes. */
  timeoutMs?: number;
}

type Operation = { signal: AbortSignal; interactive: boolean; token?: string };
type Unauthorized = Parameters<NonNullable<AuthProvider["onUnauthorized"]>>[0];
const activeProviders = new WeakSet<object>();

function httpUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("OAuth requires HTTPS or loopback HTTP, without URL credentials or fragments");
  return url;
}

/** Official auth() owns the protocol; this class owns host trust, interaction and cancellation. */
export class McpOAuthSession {
  readonly timeoutMs: number;
  readonly authProvider: AuthProvider;
  private readonly context = new AsyncLocalStorage<Operation>();
  private readonly lifetime = new AbortController();
  private readonly origins: Set<string>;
  private readonly resource: URL;
  private readonly provider: OAuthClientProvider;
  private readonly redirect?: URL;
  private pending?: Promise<void>;
  private expectedState?: string;
  private authorizationUrl?: URL;
  private closed = false;

  constructor(private readonly options: McpOAuthConfig, serverUrl: string, private readonly requestTimeoutMs: number) {
    this.resource = httpUrl(serverUrl);
    if (httpUrl(options.serverUrl).href !== this.resource.href) throw new Error("OAuth credentials are bound to a different MCP URL");
    this.timeoutMs = options.timeoutMs ?? 180_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 600_000) throw new Error("Invalid OAuth timeout");
    this.origins = new Set([this.resource.origin, ...options.allowedOrigins.map((value) => {
      const url = httpUrl(value);
      if (url.pathname !== "/" || url.search) throw new Error("OAuth allowedOrigins must contain origins only");
      return url.origin;
    })]);
    if (options.provider.dpop) throw new Error("This MCP OAuth adapter supports Bearer tokens only");
    if (options.provider.redirectUrl !== undefined) {
      this.redirect = new URL(options.provider.redirectUrl);
      if (this.redirect.username || this.redirect.password || this.redirect.hash ||
          this.redirect.searchParams.has("state") || this.redirect.searchParams.has("code")) throw new Error("Invalid OAuth callback URL");
      if (!options.provider.discoveryState || !options.provider.saveDiscoveryState)
        throw new Error("Interactive OAuth providers must persist discoveryState alongside the PKCE verifier");
    }
    if (activeProviders.has(options.provider)) throw new Error("OAuth provider already belongs to another active connection");
    // Binding methods to the host instance preserves class private fields. State and
    // redirects are the only protocol-provider methods overridden by the adapter.
    this.provider = new Proxy(options.provider, {
      get: (target, key) => {
        if (key === "state") return () => (this.expectedState = randomBytes(32).toString("base64url"));
        if (key === "redirectToAuthorization") return (url: URL) => {
          this.checkTarget(url);
          if (!this.expectedState || url.searchParams.get("state") !== this.expectedState) throw new Error("Invalid OAuth authorization state");
          this.authorizationUrl = new URL(url);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? (...args: unknown[]) => {
          const signal = this.signal();
          signal.throwIfAborted();
          return abortable(Promise.resolve().then(() => Reflect.apply(value, target, args)), signal)
            .catch(() => { throw new Error("OAuth provider operation failed"); });
        } : value;
      },
    }) as OAuthClientProvider;
    this.authProvider = {
      token: async () => {
        const token = await this.token();
        const operation = this.context.getStore();
        if (operation) operation.token = token;
        return token;
      },
      onUnauthorized: (ctx) => this.unauthorized(ctx),
    };
    activeProviders.add(options.provider);
  }

  private signal(): AbortSignal {
    const operation = this.context.getStore();
    return operation ? AbortSignal.any([operation.signal, this.lifetime.signal]) : this.lifetime.signal;
  }
  private checkTarget(value: string | URL): URL {
    const url = httpUrl(value);
    if (!this.origins.has(url.origin)) throw new Error("OAuth target origin is not trusted by the host");
    return url;
  }
  readonly fetch = async (value: string | URL, init?: RequestInit): Promise<Response> => {
    const url = this.checkTarget(value);
    const resourceRequest = url.href === this.resource.href;
    // Subscription streams outlive the connection handshake. The official transport
    // owns their request cancellation; OAuth requests need the host operation signal.
    const signal = AbortSignal.any([
      this.lifetime.signal, ...(init?.signal ? [init.signal] : []),
      ...(!resourceRequest ? [this.signal(), AbortSignal.timeout(this.requestTimeoutMs)] : []),
    ]);
    signal.throwIfAborted();
    const response = await mcpFetch(url, { ...init, signal }).catch(() => { throw new Error("OAuth HTTP request failed"); });
    if (resourceRequest) return response;
    // Official OAuth error recovery can log error descriptions. Never pass
    // credential-bearing remote error text to that logger.
    let data: unknown;
    try { data = JSON.parse(await abortable(response.text(), signal)); }
    catch { data = { error: "server_error" }; }
    if (!response.ok || (data && typeof data === "object" && "error" in data)) {
      const remoteError = data && typeof data === "object" && "error" in data ? data.error : undefined;
      const error = Object.values(OAuthErrorCode).includes(remoteError as OAuthErrorCode) ? remoteError : "server_error";
      data = { error, error_description: "OAuth request failed" };
    }
    return new Response(JSON.stringify(data), { status: response.status, headers: { "Content-Type": "application/json" } });
  };
  run<T>(signal: AbortSignal, interactive: boolean, operation: () => Promise<T>): Promise<T> {
    return this.context.run({ signal, interactive }, () => abortable(operation(), this.signal()));
  }
  private async token(): Promise<string | undefined> {
    const tokens = await this.provider.tokens();
    if (tokens && tokens.token_type.toLowerCase() !== "bearer") throw new Error("Unsupported OAuth token type");
    return tokens?.access_token;
  }
  private async unauthorized(ctx: Unauthorized): Promise<void> {
    const operation = this.context.getStore();
    if (!operation) throw new Error("OAuth requires an active host operation");
    const current = await this.token();
    // Another request may already have rotated the token while this 401 was in flight.
    if (current && current !== operation.token) return;
    if (!this.pending) {
      this.pending = this.authenticate(ctx, operation);
      const pending = this.pending;
      const clear = () => { if (this.pending === pending) this.pending = undefined; };
      void pending.then(clear, clear);
    }
    await abortable(this.pending, this.signal());
  }
  private async authenticate(ctx: Unauthorized, operation: Operation): Promise<void> {
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
    this.authorizationUrl = undefined;
    this.expectedState = undefined;
    const options = { serverUrl: this.resource, resourceMetadataUrl, scope, fetchFn: this.fetch };
    if (await auth(this.provider, options) === "AUTHORIZED") return;
    if (!operation.interactive || !this.options.authorize || !this.authorizationUrl || !this.redirect)
      throw new Error("OAuth requires explicit registration with host authorization");
    const callback = new URL(await abortable(this.options.authorize(new URL(this.authorizationUrl), { signal: this.signal() }), this.signal()));
    this.signal().throwIfAborted();
    const expected = this.consumeState();
    const state = callback.searchParams.get("state");
    if (callback.origin !== this.redirect.origin || callback.protocol !== this.redirect.protocol ||
        callback.host !== this.redirect.host || callback.pathname !== this.redirect.pathname || callback.hash || callback.username || callback.password ||
        [...this.redirect.searchParams].some(([key, value]) => callback.searchParams.get(key) !== value) ||
        ["state", "code", "iss", "error"].some((key) => callback.searchParams.getAll(key).length > 1) ||
        !expected || !state || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected)))
      throw new Error("OAuth callback validation failed");
    const code = callback.searchParams.get("code");
    if (callback.searchParams.has("error") || !code) throw new Error("OAuth authorization was declined or incomplete");
    // Official auth() validates the stored AS binding, callback issuer and PKCE exchange.
    if (await auth(this.provider, { ...options, authorizationCode: code, iss: callback.searchParams.get("iss") ?? undefined }) !== "AUTHORIZED")
      throw new Error("OAuth token exchange failed");
  }
  private consumeState(): string | undefined {
    const state = this.expectedState;
    this.expectedState = undefined;
    return state;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    activeProviders.delete(this.options.provider);
  }
}
