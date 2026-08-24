/**
 * JSON-RPC 2.0 client for the VideoDraft MCP endpoint (POST {base}/api/mcp).
 *
 * Runtime-agnostic by design: no commander, no prompts, no process.exit, no
 * console — this file is part of the `videodraft/client` subpath export the
 * macOS app's sidecar consumes. Errors are thrown, never printed.
 */

import { AuthError, RpcError, ToolError } from "./errors.js";
import { DEFAULT_BASE_URL } from "./config.js";
import { MCP_SESSION_HEADER, type ConnectionSessionStore } from "./session.js";

/** Protocol revision the CLI negotiates; also sent as MCP-Protocol-Version. */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

export interface TokenProvider {
  /** Return a bearer token (vd_mcp_...). Throw AuthError when none is available. */
  getAccessToken(): Promise<string>;
  /**
   * Called once after a 401. Return a fresh token to retry with, or null to
   * give up (the 401 then surfaces as AuthError).
   */
  onUnauthorized?(failedToken?: string): Promise<string | null>;
}

export interface VideoDraftClientOptions {
  tokenProvider: TokenProvider;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Per-request timeout in ms. Generation submits can be slow; default 300s (server maxDuration). */
  requestTimeoutMs?: number;
  /**
   * Optional connection-session store. When present the client performs the
   * MCP `initialize` handshake once per scope, keeps the server's
   * Mcp-Session-Id, and replays it on every request — which files this
   * scope's project-less generations into their own AI Studio session
   * instead of the shared "Agent (MCP)" one. Omit for a stateless client.
   */
  session?: ConnectionSessionStore;
  /**
   * Name reported as MCP clientInfo.name during the session handshake; it
   * becomes the label of the auto-created AI Studio session ("Claude Code ·
   * Aug 22, 2026"). Defaults to the user-agent's product token.
   */
  clientName?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

export class VideoDraftClient {
  readonly baseUrl: string;
  private readonly tokenProvider: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly requestTimeoutMs: number;
  private readonly session?: ConnectionSessionStore;
  private readonly clientName: string;
  /** In-memory copy of the Mcp-Session-Id for this process; null = none. */
  private sessionId: string | null | undefined;
  private handshake?: Promise<void>;
  private nextId = 1;

  constructor(options: VideoDraftClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? "videodraft-cli";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
    this.session = options.session;
    this.clientName =
      options.clientName?.trim() ||
      this.userAgent.split("/")[0] ||
      "videodraft-cli";
  }

  /** The Mcp-Session-Id this client sends, after the handshake (null = none). */
  get connectionSessionId(): string | null {
    return this.sessionId ?? null;
  }

  /**
   * Ensure we hold a Mcp-Session-Id when a store is configured: reuse the
   * stored one, else run `initialize` once and keep what the server minted.
   * Fails soft — any error here leaves sessionId null and the call proceeds
   * stateless (server falls back to the shared session).
   */
  private async ensureSession(): Promise<void> {
    if (!this.session || this.sessionId !== undefined) return;
    if (!this.handshake) {
      this.handshake = (async () => {
        const stored = this.session!.load();
        if (stored) {
          this.sessionId = stored;
          return;
        }
        try {
          const params = {
            // 2025-03-26: the last revision that still defines JSON-RPC
            // batching, which rpcBatch relies on.
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
              name: this.clientName,
              version: this.userAgent.split("/")[1] ?? "0",
            },
          };
          let token = await this.tokenProvider.getAccessToken();
          let response = await this.post("initialize", params, token, false);
          // Same 401 → refresh → retry the real calls get, so an expired
          // access token does not silently cost this process its session.
          if (response.status === 401 && this.tokenProvider.onUnauthorized) {
            const fresh = await this.tokenProvider.onUnauthorized(token);
            if (fresh) {
              token = fresh;
              response = await this.post("initialize", params, fresh, false);
            }
          }
          const minted = response.headers.get(MCP_SESSION_HEADER);
          if (response.ok && minted) {
            // save() returns the token that owns the scope: ours, or a
            // concurrent process's that claimed the directory first.
            this.sessionId = this.session!.save(minted);
            // Complete the lifecycle; the server answers 202, errors ignored.
            try {
              await this.post(
                "notifications/initialized",
                undefined,
                token,
                true,
                true,
              );
            } catch {
              // best-effort
            }
            return;
          }
        } catch {
          // stateless fallback
        }
        this.sessionId = null;
      })();
    }
    await this.handshake;
  }

  private sessionHeaders(): Record<string, string> {
    return this.sessionId ? { [MCP_SESSION_HEADER]: this.sessionId } : {};
  }

  /**
   * The server re-mints a Mcp-Session-Id on any response whose request
   * carried one it could not verify (rotated signing secret, a token minted
   * for another account on this profile). Adopt it so the store self-heals
   * instead of silently falling back to the shared session until the TTL.
   */
  private adoptSession(response: Response): void {
    if (!this.session) return;
    const fresh = response.headers.get(MCP_SESSION_HEADER);
    if (fresh && fresh !== this.sessionId) {
      this.sessionId = fresh;
      this.session.replace(fresh);
    }
  }

  get endpoint(): string {
    return `${this.baseUrl}/api/mcp`;
  }

  async rpc<T = any>(method: string, params?: unknown): Promise<T> {
    await this.ensureSession();
    const token = await this.tokenProvider.getAccessToken();
    let response = await this.post(method, params, token);

    if (response.status === 401 && this.tokenProvider.onUnauthorized) {
      const fresh = await this.tokenProvider.onUnauthorized(token);
      if (fresh) response = await this.post(method, params, fresh);
    }
    if (response.status === 401) {
      throw new AuthError("Token is invalid, expired, or revoked.");
    }
    this.adoptSession(response);
    if (!response.ok) {
      let detail = "";
      try {
        const body: any = await response.json();
        detail = body?.error?.message ?? body?.error ?? "";
      } catch {
        // non-JSON body
      }
      throw new RpcError(
        response.status,
        detail || `HTTP ${response.status} from ${this.endpoint}`,
      );
    }

    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new RpcError(
        0,
        `Server returned a non-JSON response (HTTP ${response.status}).`,
      );
    }
    if (body?.error) {
      throw new RpcError(
        body.error.code ?? -1,
        body.error.message ?? "Unknown RPC error",
        body.error.data,
      );
    }
    return body?.result as T;
  }

  private post(
    method: string,
    params: unknown,
    token: string,
    withSession = true,
    notification = false,
  ): Promise<Response> {
    return this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": this.userAgent,
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        ...(withSession ? this.sessionHeaders() : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id: this.nextId++ }),
        method,
        ...(params === undefined ? {} : { params }),
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
  }

  /**
   * Make an authenticated REST request to a non-MCP API route (e.g.
   * /api/elevenlabs-key, which manages the user's BYOK ElevenLabs key and has no
   * MCP tool by design). Uses the same bearer token + 401 refresh as rpc().
   * Returns the parsed JSON body; throws on non-2xx with the server's error.
   */
  async restRequest<T = any>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const doFetch = (token: string) =>
      this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": this.userAgent,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

    const token = await this.tokenProvider.getAccessToken();
    let response = await doFetch(token);
    if (response.status === 401 && this.tokenProvider.onUnauthorized) {
      const fresh = await this.tokenProvider.onUnauthorized(token);
      if (fresh) response = await doFetch(fresh);
    }
    if (response.status === 401) {
      throw new AuthError("Token is invalid, expired, or revoked.");
    }
    let parsed: any = null;
    try {
      parsed = await response.json();
    } catch {
      // empty / non-JSON body
    }
    if (!response.ok) {
      const detail =
        parsed?.error?.message ?? parsed?.error ?? `HTTP ${response.status}`;
      throw new RpcError(response.status, detail);
    }
    return parsed as T;
  }

  /**
   * Batch several JSON-RPC requests into ONE HTTP round trip (the server
   * implements JSON-RPC 2.0 batching). With N concurrent jobs this turns N
   * polling requests per tick into 1 — the difference between 50 waiting CLIs
   * generating ~17 req/s and ~0.3 req/s against /api/mcp.
   * Results are matched by id (order-independent per spec).
   */
  async rpcBatch(
    calls: Array<{ method: string; params?: unknown }>,
  ): Promise<any[]> {
    if (calls.length === 0) return [];
    await this.ensureSession();
    const token = await this.tokenProvider.getAccessToken();
    const ids = calls.map(() => this.nextId++);
    const payload = calls.map((c, i) => ({
      jsonrpc: "2.0" as const,
      id: ids[i],
      method: c.method,
      ...(c.params === undefined ? {} : { params: c.params }),
    }));

    const post = (bearer: string) =>
      this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
          "user-agent": this.userAgent,
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          ...this.sessionHeaders(),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

    let response = await post(token);
    if (response.status === 401 && this.tokenProvider.onUnauthorized) {
      const fresh = await this.tokenProvider.onUnauthorized(token);
      if (fresh) response = await post(fresh);
    }
    if (response.status === 401)
      throw new AuthError("Token is invalid, expired, or revoked.");
    this.adoptSession(response);
    if (!response.ok)
      throw new RpcError(
        response.status,
        `HTTP ${response.status} from ${this.endpoint}`,
      );

    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new RpcError(
        0,
        `Server returned a non-JSON response (HTTP ${response.status}).`,
      );
    }
    const responses: any[] = Array.isArray(body) ? body : [body];
    const byId = new Map(responses.map((r) => [r?.id, r]));
    return ids.map((id) => {
      const r = byId.get(id);
      if (!r) throw new RpcError(-1, `Batch response missing id ${id}`);
      if (r.error)
        throw new RpcError(
          r.error.code ?? -1,
          r.error.message ?? "Unknown RPC error",
          r.error.data,
        );
      return r.result;
    });
  }

  /**
   * Call several tools in one batched HTTP request. Per-item failures come
   * back as { ok:false, error } instead of throwing, so one failed job can't
   * abort polling of its siblings.
   */
  async callToolBatch(
    calls: Array<{ name: string; args?: Record<string, unknown> }>,
  ): Promise<Array<{ ok: boolean; result?: any; error?: string }>> {
    const results = await this.rpcBatch(
      calls.map((c) => ({
        method: "tools/call",
        params: { name: c.name, arguments: c.args ?? {} },
      })),
    );
    return results.map((result) => {
      const text = result?.content?.[0]?.text ?? "";
      if (result?.isError) {
        return {
          ok: false,
          error: text.replace(/^Error:\s*/, "") || "tool failed",
        };
      }
      try {
        return { ok: true, result: JSON.parse(text) };
      } catch {
        return { ok: true, result: text };
      }
    });
  }

  /**
   * Call an MCP tool and return its parsed result.
   * The server wraps results as { content: [{type:"text", text}], isError } —
   * text is JSON for successes and "Error: ..." for tool failures.
   */
  async callTool<T = any>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const result = await this.rpc<{
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    }>("tools/call", { name, arguments: args });
    const text = result?.content?.[0]?.text ?? "";
    if (result?.isError) {
      throw new ToolError(
        name,
        text.replace(/^Error:\s*/, "") || `Tool ${name} failed`,
        result.structuredContent,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.rpc<{ tools: McpToolInfo[] }>("tools/list");
    return result?.tools ?? [];
  }

  async ping(): Promise<void> {
    await this.rpc("ping");
  }
}

/** Static token provider — for PATs and pre-resolved tokens. */
export function staticTokenProvider(token: string): TokenProvider {
  return {
    async getAccessToken() {
      if (!token) throw new AuthError();
      return token;
    },
  };
}
