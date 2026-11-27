import { beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";
const mocks = vi.hoisted(() => ({ callTool: vi.fn() }));
vi.mock("../src/cli/context.js", async () => ({
  ...(await vi.importActual<typeof import("../src/cli/context.js")>(
    "../src/cli/context.js",
  )),
  buildContext: () => ({
    client: { callTool: mocks.callTool },
    out: { json: true, color: false, isTTY: false },
    flags: { json: true },
    baseUrl: "https://example.test",
    intervalMs: 3_000,
    timeoutMs: 600_000,
    adaptive: true,
  }),
}));
import { registerGenerateCommands } from "../src/commands/generate.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerGenerateCommands(program);
  await program.parseAsync(["generate", "video", "A fox at dusk", ...args], {
    from: "user",
  });
}

beforeEach(() => {
  mocks.callTool
    .mockReset()
    .mockResolvedValue({ job_id: "job", status: "submitted" });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

it.each(["magi-2", "magi2", "magi_2"])(
  "submits MAGI-2 text-to-video via %s with a retry key",
  async (model) => {
    await run([
      "--model",
      model,
      "--duration",
      "12",
      "--ar",
      "9:16",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_video",
      expect.objectContaining({
        model: "magi-2",
        duration_seconds: 12,
        aspect_ratio: "9:16",
        idempotency_key: expect.stringMatching(UUID),
      }),
    );
  },
);

it("keeps a supplied idempotency key for a safe retry", async () => {
  const key = "11111111-2222-4333-8444-555555555555";
  await run(["--model", "magi-2", "--idempotency-key", key, "--no-wait"]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "generate_video",
    expect.objectContaining({ model: "magi-2", idempotency_key: key }),
  );
});

it("sends first and last frames without an aspect ratio", async () => {
  await run([
    "--model",
    "magi-2",
    "--start-image",
    "https://example.com/first.png",
    "--end-image",
    "https://example.com/last.png",
    "--no-wait",
  ]);
  const args = mocks.callTool.mock.calls[0]?.[1];
  expect(args).toMatchObject({
    model: "magi-2",
    start_image_url: "https://example.com/first.png",
    end_image_url: "https://example.com/last.png",
  });
  expect(args.aspect_ratio).toBeUndefined();
});

it("sends image, video and audio references, including audio-only", async () => {
  await run([
    "--model",
    "magi-2",
    "--ref",
    "https://example.com/woman.png",
    "--ref-video",
    "https://example.com/move.mp4",
    "--ref-audio",
    "https://example.com/voice.mp3",
    "--no-wait",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "generate_video",
    expect.objectContaining({
      model: "magi-2",
      reference_images: ["https://example.com/woman.png"],
      reference_videos: ["https://example.com/move.mp4"],
      reference_audio: ["https://example.com/voice.mp3"],
    }),
  );
  mocks.callTool.mockClear();
  await run([
    "--model",
    "magi-2",
    "--ref-audio",
    "https://example.com/voice.mp3",
    "--no-wait",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "generate_video",
    expect.objectContaining({
      model: "magi-2",
      reference_audio: ["https://example.com/voice.mp3"],
    }),
  );
});

it("estimates through get_model_costs at the requested duration", async () => {
  await run(["--model", "magi2", "--duration", "30", "--estimate"]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "get_model_costs",
    expect.objectContaining({ model_id: "magi-2", duration_seconds: 30 }),
  );
});

it.each([
  ["--duration", "3"],
  ["--duration", "31"],
  ["--duration", "4.5"],
  ["--resolution", "720p"],
  ["--quality", "pro"],
  ["--auto-duration"],
  ["--no-audio"],
  ["--seed", "7"],
  ["--negative", "blurry"],
  ["--ar", "auto"],
  ["--end-image", "https://example.com/last.png"],
  ["--idempotency-key", "not-a-uuid"],
  [
    "--start-image",
    "https://example.com/first.png",
    "--ref",
    "https://example.com/ref.png",
  ],
  ["--start-image", "https://example.com/first.png", "--ar", "16:9"],
  [
    "--ref-video",
    "https://example.com/1.mp4",
    "--ref-video",
    "https://example.com/2.mp4",
    "--ref-video",
    "https://example.com/3.mp4",
    "--ref-video",
    "https://example.com/4.mp4",
    "--ref-video",
    "https://example.com/5.mp4",
    "--ref-video",
    "https://example.com/6.mp4",
  ],
])(
  "rejects unsupported MAGI-2 input %j before calling MCP",
  async (...args) => {
    await expect(
      run(["--model", "magi-2", ...args, "--no-wait"]),
    ).rejects.toThrow();
    expect(mocks.callTool).not.toHaveBeenCalled();
  },
);

it("still refuses --idempotency-key on other non-draft models", async () => {
  await expect(
    run([
      "--model",
      "kling-4.0",
      "--idempotency-key",
      "11111111-2222-4333-8444-555555555555",
      "--no-wait",
    ]),
  ).rejects.toThrow(/--draft or --model magi-2/);
  expect(mocks.callTool).not.toHaveBeenCalled();
});
