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

import { registerGenerateCommands } from "../src/commands/generate.js";

async function runGenerate(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json");
  registerGenerateCommands(program);
  await program.parseAsync(args, { from: "user" });
}

describe("MiniMax H3 Max video generation", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({
      job_id: "job_h3_max",
      status: "submitted",
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it.each(["minimax-h3-max", "h3-max", "h3max", "minimax_h3_max"])(
    "canonicalizes %s before estimating with H3 Max-only flags",
    async (model) => {
      await runGenerate([
        "generate",
        "video",
        "A cyclist races through rain",
        "--estimate",
        "--model",
        model,
        "--duration",
        "8",
        "--resolution",
        "768P",
        "--prompt-expansion-mode",
        "quality",
        "--safety-checker",
        "false",
        "--seed=-42",
      ]);

      expect(mocks.callTool).toHaveBeenCalledOnce();
      expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
        model_id: "minimax-h3-max",
        type: "video",
        duration_seconds: 8,
        resolution: "768p",
      });
    },
  );

  it.each(["minimax-h3-max", "h3-max", "h3max", "minimax_h3_max"])(
    "canonicalizes %s and preserves H3 Max controls on submission",
    async (model) => {
      await runGenerate([
        "generate",
        "video",
        "Move smoothly from the first frame to the last",
        "--model",
        model,
        "--duration",
        "8",
        "--resolution",
        "480P",
        "--start-image",
        "https://cdn.example.test/start.png",
        "--end-image",
        "https://cdn.example.test/end.png",
        "--prompt-expansion-mode",
        "quality",
        "--safety-checker",
        "false",
        "--seed=-42",
        "--no-wait",
      ]);

      expect(mocks.callTool).toHaveBeenCalledOnce();
      expect(mocks.callTool).toHaveBeenCalledWith("generate_video", {
        prompt: "Move smoothly from the first frame to the last",
        model: "minimax-h3-max",
        duration_seconds: 8,
        resolution: "480p",
        start_image_url: "https://cdn.example.test/start.png",
        end_image_url: "https://cdn.example.test/end.png",
        prompt_expansion_mode: "quality",
        enable_safety_checker: false,
        seed: -42,
      });
    },
  );

  it("infers H3 Max from its prompt-expansion mode", async () => {
    await runGenerate([
      "generate",
      "video",
      "A moonlit tracking shot",
      "--estimate",
      "--prompt-expansion-mode",
      "balanced",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "minimax-h3-max",
      type: "video",
    });
  });

  it("sends ordered references in reference mode", async () => {
    await runGenerate([
      "generate",
      "video",
      "Image 1 is the rider. Video 1 sets the camera move.",
      "--model",
      "minimax-h3-max",
      "--duration",
      "8",
      "--ar",
      "adaptive",
      "--ref",
      "https://cdn.example.test/rider.png",
      "--ref-video",
      "https://cdn.example.test/camera.mp4",
      "--ref-audio",
      "https://cdn.example.test/dialogue.wav",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("generate_video", {
      prompt: "Image 1 is the rider. Video 1 sets the camera move.",
      model: "minimax-h3-max",
      duration_seconds: 8,
      aspect_ratio: "adaptive",
      reference_images: ["https://cdn.example.test/rider.png"],
      reference_videos: ["https://cdn.example.test/camera.mp4"],
      reference_audio: ["https://cdn.example.test/dialogue.wav"],
    });
  });

  it.each([
    {
      name: "references combined with frames",
      args: [
        "--start-image",
        "https://cdn.example.test/start.png",
        "--ref",
        "https://cdn.example.test/reference.png",
      ],
      message: "frame mode and reference mode are separate",
    },
    {
      name: "audio as the only reference",
      args: ["--ref-audio", "https://cdn.example.test/dialogue.wav"],
      message: "needs at least one --ref image or --ref-video",
    },
    {
      name: "adaptive framing without references",
      args: ["--ar", "adaptive"],
      message: "adaptive is reference-mode only",
    },
    {
      name: "an out-of-range duration",
      args: ["--duration", "4"],
      message: "whole second from 5 to 15",
    },
    {
      name: "an aspect ratio with a start frame",
      args: [
        "--start-image",
        "https://cdn.example.test/start.png",
        "--ar",
        "16:9",
      ],
      message: "follows --start-image framing",
    },
    {
      name: "disabled native audio",
      args: ["--no-audio"],
      message: "always generates native audio",
    },
  ])("rejects $name before calling MCP", async ({ args, message }) => {
    await expect(
      runGenerate([
        "generate",
        "video",
        "A cinematic shot",
        "--model",
        "minimax-h3-max",
        ...args,
      ]),
    ).rejects.toThrow(message);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});
