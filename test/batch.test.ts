import { describe, expect, it } from "vitest";
import { VideoDraftClient } from "../src/core/rpc.js";
import { nextPollDelay, pollGenerationsBatch } from "../src/core/poll.js";

function batchClient(handler: (reqs: any[]) => any[]) {
  return new VideoDraftClient({
    baseUrl: "https://example.test",
    tokenProvider: { getAccessToken: async () => "vd_mcp_test" },
    fetchImpl: (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const reqs = Array.isArray(body) ? body : [body];
      return new Response(JSON.stringify(handler(reqs)), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
}

const toolText = (id: any, payload: unknown, isError = false) => ({
  jsonrpc: "2.0",
  id,
  // mirror the real server: error text is plain ("Error: ..."), successes are JSON
  result: {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
    isError,
  },
});

describe("rpcBatch / callToolBatch", () => {
  it("sends one HTTP request for N calls and matches results by id (out of order)", async () => {
    let httpCalls = 0;
    const client = batchClient((reqs) => {
      httpCalls++;
      // reply in REVERSE order — matching must be by id, not position
      return [...reqs].reverse().map((r) => toolText(r.id, { echo: r.params.arguments.job_id }));
    });
    const replies = await client.callToolBatch([
      { name: "check_generation_status", args: { job_id: "a" } },
      { name: "check_generation_status", args: { job_id: "b" } },
      { name: "check_generation_status", args: { job_id: "c" } },
    ]);
    expect(httpCalls).toBe(1);
    expect(replies.map((r) => r.result.echo)).toEqual(["a", "b", "c"]);
  });

  it("returns per-item errors without throwing", async () => {
    const client = batchClient((reqs) =>
      reqs.map((r, i) => toolText(r.id, i === 0 ? "Error: boom" : { ok: true }, i === 0)),
    );
    const replies = await client.callToolBatch([
      { name: "x", args: {} },
      { name: "y", args: {} },
    ]);
    expect(replies[0]!.ok).toBe(false);
    expect(replies[0]!.error).toBe("boom");
    expect(replies[1]!.ok).toBe(true);
  });
});

describe("pollGenerationsBatch", () => {
  it("resolves jobs independently and finishes when all are terminal", async () => {
    let tick = 0;
    const client = batchClient((reqs) => {
      tick++;
      return reqs.map((r) => {
        const id = r.params.arguments.job_id;
        if (id === "fast") return toolText(r.id, { status: "completed", outputUrls: ["https://x/f.png"] });
        if (id === "broken") return toolText(r.id, "Error: model exploded", true);
        return toolText(
          r.id,
          tick < 3 ? { status: "processing" } : { status: "completed", outputUrls: ["https://x/s.png"] },
        );
      });
    });
    const results = await pollGenerationsBatch(client, ["fast", "slow", "broken"], { intervalMs: 5, adaptive: false });
    expect(results.get("fast")!.status).toBe("completed");
    expect(results.get("broken")!.status).toBe("failed");
    expect(results.get("slow")!.status).toBe("completed");
    expect(results.get("slow")!.outputUrls).toEqual(["https://x/s.png"]);
  });
});

describe("pollGenerationsBatch chunking", () => {
  it("splits >25 jobs into multiple batch requests per tick", async () => {
    let httpCalls = 0;
    const client = batchClient((reqs) => {
      httpCalls++;
      expect(reqs.length).toBeLessThanOrEqual(25);
      return reqs.map((r) =>
        toolText(r.id, { status: "completed", outputUrls: [`https://x/${r.params.arguments.job_id}.png`] }),
      );
    });
    const ids = Array.from({ length: 30 }, (_, i) => `job_${i}`);
    const results = await pollGenerationsBatch(client, ids, { intervalMs: 5, adaptive: false });
    expect(results.size).toBe(30);
    expect(httpCalls).toBe(2); // 25 + 5, one tick
    expect(results.get("job_29")!.outputUrls).toEqual(["https://x/job_29.png"]);
  });
});

describe("nextPollDelay", () => {
  it("returns the base interval exactly when adaptive is off", () => {
    expect(nextPollDelay(3000, 999_999, false)).toBe(3000);
  });
  it("scales with elapsed time and stays within jitter bounds", () => {
    for (let i = 0; i < 50; i++) {
      const fresh = nextPollDelay(3000, 0);
      expect(fresh).toBeGreaterThanOrEqual(2700 * 0.99);
      expect(fresh).toBeLessThanOrEqual(3300 * 1.01);
      const after1m = nextPollDelay(3000, 61_000);
      expect(after1m).toBeGreaterThanOrEqual(5400 * 0.99);
      expect(after1m).toBeLessThanOrEqual(6600 * 1.01);
      const after3m = nextPollDelay(3000, 200_000);
      expect(after3m).toBeGreaterThanOrEqual(8100 * 0.99);
      expect(after3m).toBeLessThanOrEqual(9900 * 1.01);
    }
  });
  it("caps the scaled interval at 15s", () => {
    for (let i = 0; i < 20; i++) {
      expect(nextPollDelay(10_000, 500_000)).toBeLessThanOrEqual(16_500);
    }
  });
});
