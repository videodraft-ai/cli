import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoDraftClient } from "../src/core/rpc.js";
import {
  createConnectionSessionStore,
  resetAllConnectionSessions,
  sessionScope,
  SESSION_IDLE_MS,
  MCP_SESSION_HEADER,
} from "../src/core/session.js";
import { connectionSessionEnabled, sessionArg } from "../src/cli/context.js";
import { sessionIdFromToken } from "../src/core/session.js";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-session-"));
  env = { VIDEODRAFT_CONFIG_DIR: dir };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function store(
  over: Partial<Parameters<typeof createConnectionSessionStore>[0]> = {},
) {
  return createConnectionSessionStore({
    baseUrl: "https://example.test",
    profile: "default",
    cwd: "/work/a",
    env,
    ...over,
  });
}

describe("connection session store", () => {
  it("is empty until saved, then persists per scope", () => {
    const s = store();
    expect(s.load()).toBeNull();
    s.save("v1.token");
    expect(s.load()).toBe("v1.token");
    expect(store().load()).toBe("v1.token"); // same scope, new instance
    expect(store({ cwd: "/work/b" }).load()).toBeNull(); // other directory
    expect(store({ profile: "other" }).load()).toBeNull(); // other profile
    expect(store({ baseUrl: "https://staging.test" }).load()).toBeNull(); // other server
  });

  it("VIDEODRAFT_SESSION_SCOPE overrides the cwd scope", () => {
    expect(sessionScope({ baseUrl: "x", profile: "p", cwd: "/a", env })).toBe(
      "cwd:/a",
    );
    const labelled = { ...env, VIDEODRAFT_SESSION_SCOPE: "campaign-q3" };
    expect(
      sessionScope({ baseUrl: "x", profile: "p", cwd: "/a", env: labelled }),
    ).toBe("label:campaign-q3");
    store({ env: labelled, cwd: "/a" }).save("tok");
    expect(store({ env: labelled, cwd: "/somewhere/else" }).load()).toBe("tok");
  });

  it("expires after the idle window and is refreshed by use", () => {
    let t = Date.parse("2026-08-22T10:00:00Z");
    const now = () => t;
    const s = store({ now });
    s.save("tok");
    t += SESSION_IDLE_MS - 60_000;
    expect(s.load()).toBe("tok"); // touched here
    t += SESSION_IDLE_MS - 60_000;
    expect(s.load()).toBe("tok"); // still within 12h of the touch
    t += SESSION_IDLE_MS + 1;
    expect(s.load()).toBeNull();
  });

  it("reset forgets one scope; resetAll forgets every scope", () => {
    const a = store({ cwd: "/a" });
    const b = store({ cwd: "/b" });
    a.save("ta");
    b.save("tb");
    a.reset();
    expect(a.load()).toBeNull();
    expect(b.load()).toBe("tb");
    expect(resetAllConnectionSessions(env)).toBe(1);
    expect(b.load()).toBeNull();
  });

  it("survives a corrupt record", () => {
    const s = store();
    fs.mkdirSync(path.dirname(s.describe().file), { recursive: true });
    fs.writeFileSync(s.describe().file, "{not json");
    expect(s.load()).toBeNull();
    s.save("fresh");
    expect(s.load()).toBe("fresh");
  });

  it("two processes racing on an empty scope converge on the first writer's token", () => {
    const a = store();
    const b = store();
    expect(a.load()).toBeNull();
    expect(b.load()).toBeNull();
    expect(a.save("v1.from-a")).toBe("v1.from-a");
    expect(b.save("v1.from-b")).toBe("v1.from-a"); // adopts the winner
    expect(store().load()).toBe("v1.from-a");
  });

  it("save reclaims a scope whose record has expired; replace always overwrites", () => {
    let t = Date.parse("2026-08-22T10:00:00Z");
    const s = store({ now: () => t });
    s.save("old");
    t += SESSION_IDLE_MS + 1;
    expect(s.save("new")).toBe("new");
    s.replace("reminted");
    expect(s.load()).toBe("reminted");
  });

  it("describe reports expiry and the session id inside the token", () => {
    let t = Date.parse("2026-08-22T10:00:00Z");
    const s = store({ now: () => t });
    const token =
      "v1.77275bc5-ca80-4a46-982e-5425b1077f37.videodraft-cli.X-fqfcYoAkfYx0txXEhK6i2KJM7";
    s.save(token);
    expect(s.describe().expired).toBe(false);
    expect(s.describe().sessionId).toBe("77275bc5-ca80-4a46-982e-5425b1077f37");
    t += SESSION_IDLE_MS + 1;
    expect(s.describe().expired).toBe(true);
    expect(sessionIdFromToken("garbage")).toBeNull();
  });

  it("canonicalises base URL and directory spelling into one scope", () => {
    store({ baseUrl: "https://example.test/", cwd: "/work/a/" }).save("tok");
    expect(
      store({ baseUrl: "https://example.test", cwd: "/work/a" }).load(),
    ).toBe("tok");
    expect(
      store({ baseUrl: "https://EXAMPLE.test", cwd: "/work/./a" }).load(),
    ).toBe("tok");
  });

  it("a concurrent reset is not resurrected by a stale touch", () => {
    const s = store();
    s.save("tok");
    const other = store();
    other.reset();
    expect(s.load()).toBeNull();
  });

  it("sessionArg drops only the env/default value when --project is given", () => {
    const cmd = (source: string | undefined) =>
      ({ getOptionValueSource: () => source }) as any;
    // no project: any session value goes through
    expect(sessionArg(cmd("default"), { session: "env-session" })).toBe(
      "env-session",
    );
    // project + default-sourced session (VIDEODRAFT_SESSION): dropped
    expect(
      sessionArg(cmd("default"), { session: "env-session", project: "p1" }),
    ).toBeUndefined();
    // project + explicit --session: kept, even if it equals the env value
    expect(
      sessionArg(cmd("cli"), { session: "env-session", project: "p1" }),
    ).toBe("env-session");
    expect(sessionArg(cmd("cli"), { session: "explicit", project: "p1" })).toBe(
      "explicit",
    );
    // no session at all
    expect(sessionArg(cmd("cli"), { project: "p1" })).toBeUndefined();
    // old commander without getOptionValueSource: conservative drop
    expect(
      sessionArg({} as any, { session: "x", project: "p1" }),
    ).toBeUndefined();
  });

  it("two processes reclaiming an expired scope converge on one token", () => {
    let t = Date.parse("2026-08-22T10:00:00Z");
    const a = store({ now: () => t });
    const b = store({ now: () => t });
    a.save("old");
    t += SESSION_IDLE_MS + 1;
    // Both observe the expired record; the reclaim lock decides.
    const ra = a.save("from-a");
    const rb = b.save("from-b");
    expect(ra).toBe(rb);
    expect(store({ now: () => t }).load()).toBe(ra);
  });

  it("a reclaimer that loses the lock adopts the holder's record, never overwrites it", () => {
    let t = Date.parse("2026-08-22T10:00:00Z");
    const s = store({ now: () => t });
    s.save("old");
    t += SESSION_IDLE_MS + 1;
    // Simulate another process mid-reclaim: it holds the lock and has just
    // installed its fresh record.
    const file = s.describe().file;
    fs.writeFileSync(`${file}.lock`, "9999", { flag: "wx" });
    const winner = store({ now: () => t });
    winner.replace("holder-token");
    expect(s.save("loser-token")).toBe("holder-token");
    expect(s.load()).toBe("holder-token");
    fs.rmSync(`${file}.lock`, { force: true });
  });

  it("only one of two racers may break the same stale lock", () => {
    let t = Date.parse("2026-08-22T10:00:00Z");
    const a = store({ now: () => t });
    a.save("old");
    t += SESSION_IDLE_MS + 1;
    const file = a.describe().file;
    // A crashed holder's lock, old enough to break.
    fs.writeFileSync(`${file}.lock`, "dead", { flag: "wx" });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, past, past);
    // First reclaim breaks it and installs its record; the lock it leaves
    // behind is fresh, so a second racer must NOT break that one too.
    const first = a.save("from-a");
    fs.writeFileSync(`${file}.lock`, "holder", { flag: "wx" });
    const b = store({ now: () => t });
    expect(b.save("from-b")).toBe(first);
    fs.rmSync(`${file}.lock`, { force: true });
  });

  it("a touch cannot resurrect a record another process reset or replaced", () => {
    let t = Date.parse("2026-08-22T10:00:00Z");
    const reader = store({ now: () => t });
    reader.save("original");
    t += 60_000;
    const other = store({ now: () => t });
    other.replace("reminted");
    // reader still holds "original" in memory; loading must not write it back
    expect(reader.load()).toBe("reminted");
    expect(store({ now: () => t }).load()).toBe("reminted");
    other.reset();
    expect(store({ now: () => t }).load()).toBeNull();
  });

  it("a stale reclaim lock from a crashed process is broken", () => {
    let t = Date.parse("2026-08-22T10:00:00Z");
    const s = store({ now: () => t });
    s.save("old");
    t += SESSION_IDLE_MS + 1;
    const file = s.describe().file;
    fs.writeFileSync(`${file}.lock`, "dead", { flag: "wx" });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, past, past);
    expect(s.save("fresh")).toBe("fresh");
    expect(s.load()).toBe("fresh");
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("VIDEODRAFT_NO_SESSION disables the feature", () => {
    expect(connectionSessionEnabled({})).toBe(true);
    expect(connectionSessionEnabled({ VIDEODRAFT_NO_SESSION: "1" })).toBe(
      false,
    );
    expect(connectionSessionEnabled({ VIDEODRAFT_NO_SESSION: "true" })).toBe(
      false,
    );
    expect(connectionSessionEnabled({ VIDEODRAFT_NO_SESSION: "0" })).toBe(true);
  });
});

function rpcOk(
  id: number,
  result: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("VideoDraftClient Mcp-Session-Id handshake", () => {
  it("initialises once, stores the minted id, and replays it on every call", async () => {
    const calls: Array<{
      method: string;
      session: string | null;
      clientInfo?: any;
      protocolVersion?: string;
      id?: unknown;
      protoHeader?: string | null;
    }> = [];
    const s = store();
    const client = new VideoDraftClient({
      baseUrl: "https://example.test",
      tokenProvider: { getAccessToken: async () => "vd_mcp_test" },
      userAgent: "videodraft-cli/9.9.9",
      session: s,
      fetchImpl: (async (_url: any, init: any) => {
        const parsed = JSON.parse(init.body);
        const headers = init.headers as Record<string, string>;
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const body of items) {
          calls.push({
            method: body.method,
            session: headers[MCP_SESSION_HEADER] ?? null,
            clientInfo: body.params?.clientInfo,
            protocolVersion: body.params?.protocolVersion,
            id: body.id,
            protoHeader: headers["mcp-protocol-version"] ?? null,
          });
        }
        if (items[0].method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (items[0].method === "initialize") {
          return rpcOk(
            items[0].id,
            { protocolVersion: "2025-06-18" },
            { [MCP_SESSION_HEADER]: "v1.minted" },
          );
        }
        const results = items.map((b: any) => ({
          jsonrpc: "2.0",
          id: b.id,
          result: { content: [{ type: "text", text: "{}" }], isError: false },
        }));
        return new Response(
          JSON.stringify(Array.isArray(parsed) ? results : results[0]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }) as typeof fetch,
    });

    await client.callTool("whoami");
    await client.callTool("whoami");
    await client.callToolBatch([{ name: "whoami" }]);

    expect(calls.map((c) => c.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
      "tools/call",
    ]);
    expect(calls[0]?.protocolVersion).toBe("2025-03-26");
    expect(calls[1]?.id).toBeUndefined();
    expect(calls.every((c) => c.protoHeader === "2025-03-26")).toBe(true);
    expect(calls[0]?.session).toBeNull();
    expect(calls[0]?.clientInfo).toEqual({
      name: "videodraft-cli",
      version: "9.9.9",
    });
    expect(calls.slice(1).every((c) => c.session === "v1.minted")).toBe(true);
    expect(s.load()).toBe("v1.minted");
    expect(client.connectionSessionId).toBe("v1.minted");
  });

  it("reuses a stored id without re-initialising", async () => {
    const s = store();
    s.save("v1.stored");
    const methods: string[] = [];
    const client = new VideoDraftClient({
      baseUrl: "https://example.test",
      tokenProvider: { getAccessToken: async () => "vd_mcp_test" },
      session: s,
      fetchImpl: (async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        methods.push(body.method);
        expect((init.headers as any)[MCP_SESSION_HEADER]).toBe("v1.stored");
        return rpcOk(body.id, {
          content: [{ type: "text", text: "{}" }],
          isError: false,
        });
      }) as typeof fetch,
    });
    await client.callTool("whoami");
    expect(methods).toEqual(["tools/call"]);
  });

  it("falls back to stateless calls when the server mints nothing or initialize fails", async () => {
    for (const mode of ["no-header", "error"] as const) {
      const s = store({ cwd: `/work/${mode}` });
      const headersSeen: Array<string | null> = [];
      const client = new VideoDraftClient({
        baseUrl: "https://example.test",
        tokenProvider: { getAccessToken: async () => "vd_mcp_test" },
        session: s,
        fetchImpl: (async (_url: any, init: any) => {
          const body = JSON.parse(init.body);
          if (body.method === "initialize") {
            if (mode === "error") throw new Error("boom");
            return rpcOk(body.id, {});
          }
          headersSeen.push((init.headers as any)[MCP_SESSION_HEADER] ?? null);
          return rpcOk(body.id, {
            content: [{ type: "text", text: "{}" }],
            isError: false,
          });
        }) as typeof fetch,
      });
      await client.callTool("whoami");
      expect(headersSeen).toEqual([null]);
      expect(s.load()).toBeNull();
    }
  });

  it("refreshes an expired access token during the handshake instead of dropping the session", async () => {
    const s = store();
    const methods: string[] = [];
    const tokensSeen: string[] = [];
    const client = new VideoDraftClient({
      baseUrl: "https://example.test",
      tokenProvider: {
        getAccessToken: async () => "stale",
        onUnauthorized: async () => "fresh",
      },
      session: s,
      fetchImpl: (async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        methods.push(body.method);
        const bearer = String((init.headers as any).authorization).replace(
          "Bearer ",
          "",
        );
        tokensSeen.push(bearer);
        if (bearer === "stale") return new Response("{}", { status: 401 });
        if (body.method === "notifications/initialized")
          return new Response(null, { status: 202 });
        if (body.method === "initialize") {
          return rpcOk(
            body.id,
            {},
            { [MCP_SESSION_HEADER]: "v1.after-refresh" },
          );
        }
        expect((init.headers as any)[MCP_SESSION_HEADER]).toBe(
          "v1.after-refresh",
        );
        return rpcOk(body.id, {
          content: [{ type: "text", text: "{}" }],
          isError: false,
        });
      }) as typeof fetch,
    });
    await client.callTool("whoami");
    expect(methods).toEqual([
      "initialize",
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    expect(tokensSeen).toEqual(["stale", "fresh", "fresh", "stale", "fresh"]);
    expect(s.load()).toBe("v1.after-refresh");
  });

  it("adopts a re-minted session id from any response and persists it", async () => {
    const s = store();
    s.save("v1.stale");
    const seen: Array<string | null> = [];
    let n = 0;
    const client = new VideoDraftClient({
      baseUrl: "https://example.test",
      tokenProvider: { getAccessToken: async () => "vd_mcp_test" },
      session: s,
      fetchImpl: (async (_url: any, init: any) => {
        const parsed = JSON.parse(init.body);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        seen.push((init.headers as any)[MCP_SESSION_HEADER] ?? null);
        const results = items.map((b: any) => ({
          jsonrpc: "2.0",
          id: b.id,
          result: { content: [{ type: "text", text: "{}" }], isError: false },
        }));
        // First response re-mints (server could not verify v1.stale).
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (n++ === 0) headers[MCP_SESSION_HEADER] = "v1.reminted";
        return new Response(
          JSON.stringify(Array.isArray(parsed) ? results : results[0]),
          { status: 200, headers },
        );
      }) as typeof fetch,
    });
    await client.callTool("whoami");
    await client.callToolBatch([{ name: "whoami" }]);
    await client.callTool("whoami");
    expect(seen).toEqual(["v1.stale", "v1.reminted", "v1.reminted"]);
    expect(s.load()).toBe("v1.reminted");
  });

  it("sends no session header and no initialize when no store is configured", async () => {
    const methods: string[] = [];
    const client = new VideoDraftClient({
      baseUrl: "https://example.test",
      tokenProvider: { getAccessToken: async () => "vd_mcp_test" },
      fetchImpl: (async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        methods.push(body.method);
        expect((init.headers as any)[MCP_SESSION_HEADER]).toBeUndefined();
        return rpcOk(body.id, {
          content: [{ type: "text", text: "{}" }],
          isError: false,
        });
      }) as typeof fetch,
    });
    await client.callTool("whoami");
    expect(methods).toEqual(["tools/call"]);
  });
});
