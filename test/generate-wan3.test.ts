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

describe("Wan 3.0 video generation", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({
      job_id: "job_wan3",
      status: "submitted",
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("submits mixed media and link references without requiring a prompt", async () => {
    await runGenerate([
      "generate",
      "video",
      "--model",
      "wan-3.0",
      "--duration",
      "12",
      "--resolution",
      "1080p",
      "--ar",
      "adaptive",
      "--ref",
      "https://cdn.example.test/character.png",
      "--ref-video",
      "https://cdn.example.test/motion.mp4",
      "--ref-audio",
      "https://cdn.example.test/voice.wav",
      "--file-url",
      "https://cdn.example.test/brief.pdf",
      "--web-url",
      "https://example.test/reference",
      "--thinking",
      "--prompt-expansion",
      "false",
      "--project",
      "project_123",
      "--scene",
      "1",
      "--shot",
      "2",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_video", {
      model: "wan-3.0",
      aspect_ratio: "adaptive",
      duration_seconds: 12,
      resolution: "1080p",
      reference_images: ["https://cdn.example.test/character.png"],
      reference_videos: ["https://cdn.example.test/motion.mp4"],
      reference_audio: ["https://cdn.example.test/voice.wav"],
      file_url: "https://cdn.example.test/brief.pdf",
      web_url: "https://example.test/reference",
      enable_prompt_expansion: false,
      enable_thinking: true,
      project_id: "project_123",
      scene_index: 1,
      shot_index: 2,
    });
  });

  it("auto-selects Wan 3.0 and forwards auto-duration estimates", async () => {
    mocks.callTool.mockResolvedValueOnce({ credits: 196 });

    await runGenerate([
      "generate",
      "video",
      "a cinematic tracking shot",
      "--auto-duration",
      "--resolution",
      "720p",
      "--estimate",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "wan-3.0",
      type: "video",
      auto_duration: true,
      resolution: "720p",
    });
  });

  it("submits first and last frames with auto duration", async () => {
    await runGenerate([
      "generate",
      "video",
      "--model",
      "wan-3.0",
      "--start-image",
      "https://cdn.example.test/start.png",
      "--end-image",
      "https://cdn.example.test/end.png",
      "--auto-duration",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_video", {
      model: "wan-3.0",
      auto_duration: true,
      start_image_url: "https://cdn.example.test/start.png",
      end_image_url: "https://cdn.example.test/end.png",
    });
  });

  it.each([
    {
      name: "fixed and automatic duration together",
      args: ["a shot", "--duration", "5", "--auto-duration"],
      message: "mutually exclusive",
    },
    {
      name: "a duration below the provider minimum",
      args: ["a shot", "--duration", "1"],
      message: "whole second from 2 to 30",
    },
    {
      name: "an end frame without a start frame",
      args: ["a shot", "--end-image", "https://cdn.example.test/end.png"],
      message: "requires --start-image",
    },
    {
      name: "frame and reference modes together",
      args: [
        "a shot",
        "--start-image",
        "https://cdn.example.test/start.png",
        "--ref",
        "https://cdn.example.test/ref.png",
      ],
      message: "cannot combine frame inputs with reference sources",
    },
    {
      name: "a document without thinking enabled",
      args: ["--file-url", "https://cdn.example.test/brief.pdf"],
      message: "require --thinking",
    },
    {
      name: "a negative prompt",
      args: ["a shot", "--negative", "blur"],
      message: "does not support --negative",
    },
    {
      name: "an out-of-range seed",
      args: ["a shot", "--seed", "2147483648"],
      message: "whole number from 0 to 2147483647",
    },
    {
      name: "an unsupported resolution",
      args: ["a shot", "--resolution", "4K"],
      message: "480p, 720p, or 1080p",
    },
    {
      name: "an unsupported aspect ratio",
      args: ["a shot", "--ar", "3:2"],
      message: "adaptive, 16:9, 4:3, 1:1, 3:4, or 9:16",
    },
  ])("rejects $name before calling MCP", async ({ args, message }) => {
    await expect(
      runGenerate(["generate", "video", "--model", "wan-3.0", ...args]),
    ).rejects.toThrow(message);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rejects Wan 3.0-only controls on another model", async () => {
    await expect(
      runGenerate([
        "generate",
        "video",
        "a shot",
        "--model",
        "seedance-2",
        "--prompt-expansion",
        "false",
      ]),
    ).rejects.toThrow("supported only by --model wan-3.0");
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it.each(["wan-2.7", "wan27", "wan-2.7-ref-edit"])(
    "rejects retired model id %s",
    async (model) => {
      await expect(
        runGenerate(["generate", "video", "a shot", "--model", model]),
      ).rejects.toThrow("Wan 2.7 is retired");
      expect(mocks.callTool).not.toHaveBeenCalled();
    },
  );
});
