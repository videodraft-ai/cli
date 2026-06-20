/**
 * JSON-RPC 2.0 client for the VideoDraft MCP endpoint (POST {base}/api/mcp).
 *
 * Runtime-agnostic by design: no commander, no prompts, no process.exit, no
 * console — this file is part of the `videodraft/client` subpath export the
 * macOS app's sidecar consumes. Errors are thrown, never printed.
 */

import { AuthError, RpcError, ToolError } from "./errors.js";
import { DEFAULT_BASE_URL } from "./config.js";

export interface TokenProvider {
  /** Return a bearer token (vd_mcp_...). Throw AuthError when none is available. */
  getAccessToken(): Promise<string>;
  /**
   * Called once after a 401. Return a fresh token to retry with, or null to
   * give up (the 401 then surfaces as AuthError).
   */
  onUnauthorized?(): Promise<string | null>;
}

export interface VideoDraftClientOptions {
  tokenProvider: TokenProvider;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Per-request timeout in ms. Generation submits can be slow; default 300s (server maxDuration). */
  requestTimeoutMs?: number;
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
  private nextId = 1;

  constructor(options: VideoDraftClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? "videodraft-cli";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
  }

  get endpoint(): string {
    return `${this.baseUrl}/api/mcp`;
  }

  async rpc<T = any>(method: string, params?: unknown): Promise<T> {
    const token = await this.tokenProvider.getAccessToken();
    let response = await this.post(method, params, token);

    if (response.status === 401 && this.tokenProvider.onUnauthorized) {
      const fresh = await this.tokenProvider.onUnauthorized();
      if (fresh) response = await this.post(method, params, fresh);
    }
    if (response.status === 401) {
      throw new AuthError("Token is invalid, expired, or revoked.");
    }
    if (!response.ok) {
      let detail = "";
      try {
        const body: any = await response.json();
        detail = body?.error?.message ?? body?.error ?? "";
      } catch {
        // non-JSON body
      }
      throw new RpcError(response.status, detail || `HTTP ${response.status} from ${this.endpoint}`);
    }

    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new RpcError(0, `Server returned a non-JSON response (HTTP ${response.status}).`);
    }
    if (body?.error) {
      throw new RpcError(body.error.code ?? -1, body.error.message ?? "Unknown RPC error", body.error.data);
    }
    return body?.result as T;
  }

  private post(method: string, params: unknown, token: string): Promise<Response> {
    return this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": this.userAgent,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        ...(params === undefined ? {} : { params }),
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
  }

  /**
   * Batch several JSON-RPC requests into ONE HTTP round trip (the server
   * implements JSON-RPC 2.0 batching). With N concurrent jobs this turns N
   * polling requests per tick into 1 — the difference between 50 waiting CLIs
   * generating ~17 req/s and ~0.3 req/s against /api/mcp.
   * Results are matched by id (order-independent per spec).
   */
  async rpcBatch(calls: Array<{ method: string; params?: unknown }>): Promise<any[]> {
    if (calls.length === 0) return [];
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
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

    let response = await post(token);
    if (response.status === 401 && this.tokenProvider.onUnauthorized) {
      const fresh = await this.tokenProvider.onUnauthorized();
      if (fresh) response = await post(fresh);
    }
    if (response.status === 401) throw new AuthError("Token is invalid, expired, or revoked.");
    if (!response.ok) throw new RpcError(response.status, `HTTP ${response.status} from ${this.endpoint}`);

    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new RpcError(0, `Server returned a non-JSON response (HTTP ${response.status}).`);
    }
    const responses: any[] = Array.isArray(body) ? body : [body];
    const byId = new Map(responses.map((r) => [r?.id, r]));
    return ids.map((id) => {
      const r = byId.get(id);
      if (!r) throw new RpcError(-1, `Batch response missing id ${id}`);
      if (r.error) throw new RpcError(r.error.code ?? -1, r.error.message ?? "Unknown RPC error", r.error.data);
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
      calls.map((c) => ({ method: "tools/call", params: { name: c.name, arguments: c.args ?? {} } })),
    );
    return results.map((result) => {
      const text = result?.content?.[0]?.text ?? "";
      if (result?.isError) {
        return { ok: false, error: text.replace(/^Error:\s*/, "") || "tool failed" };
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
  async callTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.rpc<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>(
      "tools/call",
      { name, arguments: args },
    );
    const text = result?.content?.[0]?.text ?? "";
    if (result?.isError) {
      throw new ToolError(name, text.replace(/^Error:\s*/, "") || `Tool ${name} failed`);
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
