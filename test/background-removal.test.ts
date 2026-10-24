import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Command } from "commander";
const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  poll: vi.fn(),
  download: vi.fn(),
}));
vi.mock("../src/cli/context.js", async () => ({
  ...(await vi.importActual<typeof import("../src/cli/context.js")>(
    "../src/cli/context.js",
  )),
  buildContext: () => ({
    client: { callTool: mocks.callTool },
    out: { json: true, color: false, isTTY: false },
    flags: { json: true },
    intervalMs: 1,
    timeoutMs: 100,
    adaptive: false,
  }),
}));
vi.mock("../src/cli/telemetry.js", () => ({ capture: vi.fn() }));
vi.mock("../src/core/poll.js", async () => ({
  ...(await vi.importActual<typeof import("../src/core/poll.js")>(
    "../src/core/poll.js",
  )),
  pollGeneration: mocks.poll,
}));
vi.mock("../src/core/download.js", async () => ({
  ...(await vi.importActual<typeof import("../src/core/download.js")>(
    "../src/core/download.js",
  )),
  downloadOutputs: mocks.download,
}));
import { registerBackgroundRemovalCommands } from "../src/commands/background-removal.js";
const ID = "11111111-1111-4111-8111-111111111111",
  URL = "https://cdn.videodraft.ai/user/vid/input.mp4";
async function run(args: string[]) {
  const p = new Command().option("--json");
  registerBackgroundRemovalCommands(p);
  await p.parseAsync(args, { from: "user" });
}
describe("background removal commands", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.callTool
      .mockReset()
      .mockResolvedValue({ job_id: ID, status: "pending" });
    mocks.poll.mockReset().mockResolvedValue({
      status: "completed",
      outputUrls: [URL.replace("input.mp4", "output.webm")],
      payload: { type: "video" },
    });
    mocks.download.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());
  it("passes an explicit stable operation ID and image source", async () => {
    await run([
      "remove-background",
      "image",
      "https://cdn.videodraft.ai/user/img/source.png",
      "--idempotency-key",
      ID,
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith("remove_image_background", {
      image_url: "https://cdn.videodraft.ai/user/img/source.png",
      idempotency_key: ID,
    });
    expect(mocks.poll).not.toHaveBeenCalled();
  });
  it("preserves object mode, false refinement, and a spend cap", async () => {
    await run([
      "remove-background",
      "video",
      URL,
      "--subject",
      "object",
      "--no-refine-edges",
      "--max-credits",
      "4",
      "--idempotency-key",
      ID,
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith("remove_video_background", {
      video_url: URL,
      subject: "object",
      refine_edges: false,
      max_credits: 4,
      idempotency_key: ID,
    });
  });
  it("estimates against the actual source without starting a job", async () => {
    mocks.callTool.mockResolvedValue({ cost: 7 });
    await run(["remove-background", "video", URL, "--estimate"]);
    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "veed-background-removal",
      source_url: URL,
      refine_edges: true,
    });
    expect(mocks.poll).not.toHaveBeenCalled();
  });
  it("waits by default and downloads the transparent file", async () => {
    await run(["remove-background", "video", URL, "--download", "cutout.webm"]);
    expect(mocks.poll).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      expect.anything(),
    );
    expect(mocks.download).toHaveBeenCalledWith(
      [URL.replace("input.mp4", "output.webm")],
      "cutout.webm",
      { job_id: ID },
    );
  });
  it("keeps the operation ID when the MCP response is lost", async () => {
    mocks.callTool.mockRejectedValue(new Error("connection lost"));
    await expect(
      run(["remove-background", "video", URL, "--idempotency-key", ID]),
    ).rejects.toMatchObject({ data: { job_id: ID } });
    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.poll).not.toHaveBeenCalled();
  });
  it.each([
    ["--download", "flattened.mp4"],
    ["--subject", "everything"],
    ["--max-credits", "-1"],
    ["--idempotency-key", "bad-id"],
  ])("rejects invalid %s before a paid call", async (flag, value) => {
    await expect(
      run(["remove-background", "video", URL, flag, value]),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});
