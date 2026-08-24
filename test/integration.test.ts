/**
 * Live integration smoke — opt-in, costs nothing (read-only tools).
 *
 *   VIDEODRAFT_TEST_BASE_URL=http://localhost:3000 \
 *   VIDEODRAFT_TEST_TOKEN=vd_mcp_... \
 *   pnpm test
 */

import { describe, expect, it } from "vitest";
import { VideoDraftClient } from "../src/core/rpc.js";

const baseUrl = process.env.VIDEODRAFT_TEST_BASE_URL;
const token = process.env.VIDEODRAFT_TEST_TOKEN;
const enabled = Boolean(baseUrl && token);

describe.skipIf(!enabled)("live MCP integration", () => {
  const client = new VideoDraftClient({
    baseUrl: baseUrl!,
    tokenProvider: { getAccessToken: async () => token! },
  });

  it("whoami returns the authenticated user", async () => {
    const me: any = await client.callTool("whoami");
    expect(me?.user_id ?? me?.id ?? me?.email).toBeTruthy();
  });

  it("get_credits_balance returns a number", async () => {
    const balance: any = await client.callTool("get_credits_balance");
    expect(typeof balance?.availableCredits).toBe("number");
  });

  it("tools/list exposes the catalog with schemas", async () => {
    const tools = await client.listTools();
    expect(tools.length).toBeGreaterThan(50);
    const generateImage = tools.find((t) => t.name === "generate_image");
    expect(generateImage?.inputSchema).toBeTruthy();
  });

  it("list_available_image_models returns models", async () => {
    const models: any = await client.callTool("list_available_image_models");
    expect(Array.isArray(models?.models ?? models)).toBe(true);
  });
});
