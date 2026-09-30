import { beforeEach, describe, expect, it, vi } from "vitest";
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
    intervalMs: 3000,
    timeoutMs: 600000,
    adaptive: true,
  }),
}));
import { registerGenerateCommands } from "../src/commands/generate.js";
import { registerEditCommands } from "../src/commands/edit.js";
async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerGenerateCommands(program);
  registerEditCommands(program);
  await program.parseAsync(args, { from: "user" });
}
beforeEach(() => {
  mocks.callTool
    .mockReset()
    .mockResolvedValue({ job_id: "job", status: "submitted" });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
describe("AI Studio option parity", () => {
  it("preserves Nano temperature zero and disabled search", async () => {
    await run([
      "generate",
      "image",
      "A boat",
      "--model",
      "nano-banana-pro",
      "--temperature",
      "0",
      "--google-search-grounding",
      "false",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_image",
      expect.objectContaining({
        temperature: 0,
        google_search_grounding: false,
      }),
    );
  });
  it("supports promptless Qwen camera adjustments", async () => {
    await run([
      "generate",
      "image",
      "--model",
      "qwen-multi-angle",
      "--ref",
      "https://example.test/ref.png",
      "--horizontal-angle",
      "0",
      "--vertical-angle=-30",
      "--zoom",
      "0",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_image",
      expect.objectContaining({
        horizontal_angle: 0,
        vertical_angle: -30,
        zoom: 0,
      }),
    );
  });
  it("translates Recraft hex palette and background to RGB", async () => {
    await run([
      "generate",
      "image",
      "A logo",
      "--model",
      "recraft-v4",
      "--quality",
      "Pro",
      "--recraft-color",
      "#0019ff",
      "--recraft-background",
      "ffffff",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_image",
      expect.objectContaining({
        quality: "Pro",
        recraft_colors: [{ r: 0, g: 25, b: 255 }],
        recraft_background_color: { r: 255, g: 255, b: 255 },
      }),
    );
  });
  it("preserves random seed zero", async () => {
    await run([
      "generate",
      "image",
      "A boat",
      "--model",
      "seedream-4.5",
      "--seed",
      "0",
      "--resolution",
      "4K",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_image",
      expect.objectContaining({ seed: 0, resolution: "4K" }),
    );
  });
  it.each(["seedance-2", "seedance-2.5", "flux-3", "gemini-omni-1.1-flash"])(
    "supports explicit automatic duration for %s",
    async (model) => {
      await run([
        "generate",
        "video",
        "A boat",
        "--model",
        model,
        "--auto-duration",
        "--no-wait",
      ]);
      expect(mocks.callTool).toHaveBeenCalledWith(
        "generate_video",
        expect.objectContaining({ model, auto_duration: true }),
      );
    },
  );
  it("preserves empty negative prompt and zero CFG", async () => {
    await run([
      "generate",
      "video",
      "A boat",
      "--model",
      "kling-3.0",
      "--negative",
      "",
      "--cfg-scale",
      "0",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_video",
      expect.objectContaining({ negative_prompt: "", cfg_scale: 0 }),
    );
  });
  it("passes Sora Pro on the same picker ID", async () => {
    await run([
      "generate",
      "video",
      "A boat",
      "--model",
      "sora-2",
      "--quality",
      "pro",
      "--resolution",
      "1080p",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_video",
      expect.objectContaining({ quality: "pro", resolution: "1080p" }),
    );
  });
  it("supports O3 image elements for video edit", async () => {
    const element = {
      frontal_image_url: "https://example.test/front.png",
      reference_image_urls: ["https://example.test/side.png"],
    };
    await run([
      "edit",
      "video",
      "https://example.test/input.mp4",
      "Replace the boat",
      "--model",
      "kling-o3-video-ref-edit",
      "--element",
      JSON.stringify(element),
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "edit_video",
      expect.objectContaining({ elements: [element] }),
    );
  });
  it("preserves Happy Horse edit seed and safety toggle", async () => {
    await run([
      "edit",
      "video",
      "https://example.test/input.mp4",
      "Add snow",
      "--model",
      "happy-horse-video-edit",
      "--seed",
      "0",
      "--safety-checker",
      "false",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "edit_video",
      expect.objectContaining({ seed: 0, enable_safety_checker: false }),
    );
  });
  it("rejects invalid controls before uploads or paid requests", async () => {
    await expect(
      run(["generate", "image", "A boat", "--temperature", "NaN"]),
    ).rejects.toThrow(/temperature/);
    await expect(
      run([
        "generate",
        "video",
        "A boat",
        "--model",
        "kling-3.0",
        "--cfg-scale",
        "2",
      ]),
    ).rejects.toThrow(/cfg-scale/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});

it("routed Topaz image returns its async handle with --no-wait", async () => {
  await run([
    "upscale",
    "image",
    "https://example.test/source.png",
    "--no-wait",
  ]);
  expect(mocks.callTool).toHaveBeenCalledOnce();
  expect(mocks.callTool).toHaveBeenCalledWith(
    "upscale_image",
    expect.objectContaining({ image_url: "https://example.test/source.png" }),
  );
});

describe("FLUX 3 fixed-frame estimate defaults", () => {
  const fixedFrameInputs = [
    [
      "--start-image",
      "https://example.test/start.png",
      "--end-image",
      "https://example.test/end.png",
    ],
    [
      "--keyframe",
      "https://example.test/start.png@0",
      "--keyframe",
      "https://example.test/end.png@5",
    ],
  ];
  for (const model of ["flux-3", "flux3", "flux_3"]) {
    it.each(fixedFrameInputs)(
      `${model} estimates fixed-frame input %j at five seconds unless duration is explicit`,
      async (...frames) => {
        for (const quality of ["standard", "draft"])
          for (const duration of [undefined, "12"]) {
            mocks.callTool.mockClear();
            await run([
              "generate",
              "video",
              "A boat",
              "--model",
              model,
              "--quality",
              quality,
              ...frames,
              ...(duration ? ["--duration", duration] : []),
              "--estimate",
            ]);
            expect(mocks.callTool).toHaveBeenCalledOnce();
            expect(mocks.callTool).toHaveBeenCalledWith(
              "get_model_costs",
              expect.objectContaining({
                model_id: model,
                quality,
                duration_seconds: duration ? 12 : 5,
              }),
            );
            expect(mocks.callTool.mock.calls[0]?.[1]).not.toHaveProperty(
              "auto_duration",
            );
          }
      },
    );
    it(`${model} preserves ordinary text and first-frame auto estimates`, async () => {
      for (const frame of [
        [],
        ["--start-image", "https://example.test/start.png"],
      ])
        for (const auto of [false, true]) {
          mocks.callTool.mockClear();
          await run([
            "generate",
            "video",
            "A boat",
            "--model",
            model,
            ...frame,
            ...(auto ? ["--auto-duration"] : []),
            "--estimate",
          ]);
          expect(mocks.callTool).toHaveBeenCalledOnce();
          expect(mocks.callTool).toHaveBeenCalledWith(
            "get_model_costs",
            expect.objectContaining({ model_id: model }),
          );
          expect(mocks.callTool.mock.calls[0]?.[1]).not.toHaveProperty(
            "duration_seconds",
          );
          if (auto)
            expect(mocks.callTool.mock.calls[0]?.[1]).toHaveProperty(
              "auto_duration",
              true,
            );
          else
            expect(mocks.callTool.mock.calls[0]?.[1]).not.toHaveProperty(
              "auto_duration",
            );
        }
    });
    it.each(fixedFrameInputs)(
      `${model} refuses auto duration for fixed-frame input %j before estimation or submission`,
      async (...frames) => {
        for (const mode of ["--estimate", "--no-wait"]) {
          mocks.callTool.mockClear();
          await expect(
            run([
              "generate",
              "video",
              "A boat",
              "--model",
              model,
              ...frames,
              "--auto-duration",
              mode,
            ]),
          ).rejects.toThrow(/auto-duration.*text.*first.frame/);
          expect(mocks.callTool).not.toHaveBeenCalled();
        }
      },
    );
  }
});
