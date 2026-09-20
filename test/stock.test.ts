import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
}));

vi.mock("../src/cli/context.js", async () => {
  const actual = await vi.importActual<typeof import("../src/cli/context.js")>(
    "../src/cli/context.js",
  );
  return {
    ...actual,
    buildContext: () => ({
      client: { callTool: mocks.callTool },
      out: { json: true, color: false, isTTY: false },
      flags: { json: true },
      baseUrl: "https://example.test",
      intervalMs: 3_000,
      timeoutMs: 600_000,
      adaptive: true,
    }),
  };
});

import { registerStockCommands } from "../src/commands/stock.js";

async function runStock(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json");
  program.exitOverride();
  registerStockCommands(program);
  await program.parseAsync(args, { from: "user" });
}

describe("videodraft stock search", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({ results: [], providers: [] });
  });

  it("sends the joined query and only the flags that were passed", async () => {
    await runStock(["stock", "search", "city", "skyline", "at", "night"]);
    expect(mocks.callTool).toHaveBeenCalledWith("search_stock_media", {
      query: "city skyline at night",
    });
  });

  it("maps filters to tool arguments as numbers", async () => {
    await runStock([
      "stock",
      "search",
      "waves",
      "--type",
      "image",
      "--orientation",
      "portrait",
      "--provider",
      "pexels",
      "--min-duration",
      "5",
      "--max-duration",
      "20",
      "--min-resolution",
      "1920",
      "--limit",
      "4",
      "--page",
      "2",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith("search_stock_media", {
      query: "waves",
      type: "image",
      orientation: "portrait",
      provider: "pexels",
      min_duration_seconds: 5,
      max_duration_seconds: 20,
      min_resolution: 1920,
      limit: 4,
      page: 2,
    });
  });

  it.each([
    ["--type", "audio"],
    ["--orientation", "wide"],
    ["--provider", "shutterstock"],
  ])("rejects an unsupported %s value", async (flag, value) => {
    await expect(
      runStock(["stock", "search", "x", flag, value]),
    ).rejects.toThrow(/must be one of/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});

describe("videodraft stock import", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({
      url: "https://cdn.videodraft.ai/u/vid/abc.mp4",
      rendition: "1080p",
      width: 1920,
      height: 1080,
      source: {
        attribution: "Video by Jane Doe on Pexels",
        page_url: "https://www.pexels.com/video/x-1/",
      },
    });
  });

  it("passes the ref through and defaults the quality server-side", async () => {
    await runStock(["stock", "import", "pexels:video:35379336"]);
    expect(mocks.callTool).toHaveBeenCalledWith("import_stock_media", {
      ref: "pexels:video:35379336",
    });
  });

  it("forwards an explicit quality", async () => {
    await runStock([
      "stock",
      "import",
      "pixabay:video:31956",
      "--quality",
      "4k",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith("import_stock_media", {
      ref: "pixabay:video:31956",
      quality: "4k",
    });
  });

  it("rejects an unsupported quality before calling the API", async () => {
    await expect(
      runStock(["stock", "import", "pexels:video:1", "--quality", "8k"]),
    ).rejects.toThrow(/must be one of/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});
