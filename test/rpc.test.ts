import { describe, expect, it } from "vitest";
import { VideoDraftClient } from "../src/core/rpc.js";
import { AuthError, RpcError, ToolError, EXIT } from "../src/core/errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rpcResult(result: unknown) {
  return { jsonrpc: "2.0", id: 1, result };
}

function toolText(payload: unknown, isError = false) {
  return rpcResult({
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
    isError,
  });
}

function clientWith(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return new VideoDraftClient({
    baseUrl: "https://example.test",
    tokenProvider: { getAccessToken: async () => "vd_mcp_test" },
    fetchImpl: (async (url: any, init: any) => handler(String(url), init)) as typeof fetch,
  });
}

describe("VideoDraftClient", () => {
  it("sends a JSON-RPC envelope with bearer auth and parses tool JSON", async () => {
    let captured: any;
    const client = clientWith((url, init) => {
      captured = { url, init };
      return jsonResponse(toolText({ availableCredits: 420 }));
    });
    const result = await client.callTool("get_credits_balance");
    expect(result.availableCredits).toBe(420);
    expect(captured.url).toBe("https://example.test/api/mcp");
    expect((captured.init.headers as any).authorization).toBe("Bearer vd_mcp_test");
    const body = JSON.parse(captured.init.body);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("get_credits_balance");
  });

  it("throws ToolError on isError results", async () => {
    const client = clientWith(() => jsonResponse(toolText("Error: Project not found", true)));
    await expect(client.callTool("get_project", { project_id: "x" })).rejects.toThrowError(ToolError);
    await expect(client.callTool("get_project", { project_id: "x" })).rejects.toThrow(/Project not found/);
  });

  it("maps insufficient-credit tool errors to exit code 4", async () => {
    const client = clientWith(() => jsonResponse(toolText("Error: Insufficient credits for this operation", true)));
    const err = await client.callTool("generate_video", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.exitCode).toBe(EXIT.CREDITS);
  });

  it("surfaces JSON-RPC envelope errors as RpcError", async () => {
    const client = clientWith(() =>
      jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Unknown tool: nope" } }),
    );
    await expect(client.rpc("tools/call", { name: "nope" })).rejects.toThrowError(RpcError);
  });

  it("retries once via onUnauthorized after a 401, then succeeds", async () => {
    let calls = 0;
    const client = new VideoDraftClient({
      baseUrl: "https://example.test",
      tokenProvider: {
        getAccessToken: async () => "vd_mcp_stale",
        onUnauthorized: async () => "vd_mcp_fresh",
      },
      fetchImpl: (async (_url: any, init: any) => {
        calls++;
        const auth = (init.headers as any).authorization;
        if (auth === "Bearer vd_mcp_stale") return jsonResponse({ error: "unauthorized" }, 401);
        return jsonResponse(toolText({ ok: true }));
      }) as typeof fetch,
    });
    const result = await client.callTool("whoami");
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("throws AuthError when 401 persists after refresh", async () => {
    const client = new VideoDraftClient({
      baseUrl: "https://example.test",
      tokenProvider: {
        getAccessToken: async () => "vd_mcp_dead",
        onUnauthorized: async () => null,
      },
      fetchImpl: (async () => jsonResponse({ error: "unauthorized" }, 401)) as typeof fetch,
    });
    await expect(client.callTool("whoami")).rejects.toThrowError(AuthError);
  });

  it("returns raw text when a tool result is not JSON", async () => {
    const client = clientWith(() => jsonResponse(toolText("plain text result")));
    const result = await client.callTool("get_project_schema");
    expect(result).toBe("plain text result");
  });

  it("lists tools", async () => {
    const client = clientWith(() =>
      jsonResponse(rpcResult({ tools: [{ name: "whoami", description: "d", inputSchema: {} }] })),
    );
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("whoami");
  });
});
