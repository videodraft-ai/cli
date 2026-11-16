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
async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerGenerateCommands(program);
  await program.parseAsync(["generate", "video", "A boat", ...args], {
    from: "user",
  });
}
beforeEach(() => {
  mocks.callTool
    .mockReset()
    .mockResolvedValue({ job_id: "job", status: "submitted" });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
it.each(["seedance-2.5-flash", "seedance25flash", "seedance-2-5-flash"])(
  "submits the distinct Flash model via %s",
  async (model) => {
    await run([
      "--model",
      model,
      "--duration",
      "10",
      "--resolution",
      "720p",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_video",
      expect.objectContaining({
        model: "seedance-2.5-flash",
        duration_seconds: 10,
        resolution: "720p",
      }),
    );
  },
);
it("estimates reference input duration through the same model", async () => {
  await run([
    "--model",
    "seedance-2.5-flash",
    "--duration",
    "10",
    "--resolution",
    "720p",
    "--ref-video",
    "https://example.com/reference.mp4",
    "--ref-video-seconds",
    "30",
    "--estimate",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "get_model_costs",
    expect.objectContaining({
      model_id: "seedance-2.5-flash",
      duration_seconds: 10,
      reference_video_duration_seconds: 30,
    }),
  );
});
it("supports audio-only references and automatic duration", async () => {
  await run([
    "--model",
    "seedance-2.5-flash",
    "--ref-audio",
    "https://example.com/audio.wav",
    "--auto-duration",
    "--no-wait",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "generate_video",
    expect.objectContaining({
      model: "seedance-2.5-flash",
      reference_audio: ["https://example.com/audio.wav"],
      auto_duration: true,
    }),
  );
});
it.each([
  ["--resolution", "1080p"],
  ["--quality", "fast"],
  ["--duration", "31"],
  ["--end-image", "https://example.com/end.png"],
])("rejects unsupported Flash input %j before calling MCP", async (...args) => {
  await expect(
    run(["--model", "seedance-2.5-flash", ...args, "--no-wait"]),
  ).rejects.toThrow();
  expect(mocks.callTool).not.toHaveBeenCalled();
});
