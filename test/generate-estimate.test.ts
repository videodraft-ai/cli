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

describe("generate --estimate model selection", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({ credits: 1 });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("estimates images with the documented default when --model is omitted", async () => {
    await runGenerate(["generate", "image", "a poster", "--estimate"]);

    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "nano-banana-2",
      type: "image",
    });
  });

  it("uses an explicit image model for the estimate", async () => {
    await runGenerate([
      "generate",
      "image",
      "a poster",
      "--estimate",
      "--model",
      "gpt-image-2",
      "--resolution",
      "2K",
      "--num",
      "2",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "gpt-image-2",
      type: "image",
      resolution: "2K",
      num_images: 2,
    });
  });

  it("estimates videos with the documented default when --model is omitted", async () => {
    await runGenerate(["generate", "video", "a tracking shot", "--estimate"]);

    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "gemini-omni-flash",
      type: "video",
    });
  });

  it("uses an explicit video model for the estimate", async () => {
    await runGenerate([
      "generate",
      "video",
      "a tracking shot",
      "--estimate",
      "--model",
      "seedance-2",
      "--duration",
      "15",
      "--quality",
      "quality",
      "--audio",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "seedance-2",
      type: "video",
      duration_seconds: 15,
      quality: "quality",
      generate_audio: true,
    });
  });

  it("uses Seedance 2 for an unspecified 15-second estimate", async () => {
    await runGenerate([
      "generate",
      "video",
      "a long tracking shot",
      "--estimate",
      "--duration",
      "15",
      "--audio",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "seedance-2",
      type: "video",
      duration_seconds: 15,
      generate_audio: true,
    });
  });

  it("uses Seedance 2 for an unspecified mixed-reference estimate", async () => {
    await runGenerate([
      "generate",
      "video",
      "preserve all references",
      "--estimate",
      "--ref",
      "character.png",
      "--ref-video",
      "movement.mp4",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "seedance-2",
      type: "video",
    });
  });

  it("uses the runtime 6-second default for a task-routed Veo estimate", async () => {
    await runGenerate([
      "generate",
      "video",
      "a silent cinematic shot",
      "--estimate",
      "--no-audio",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "google-veo3.1",
      type: "video",
      duration_seconds: 6,
      generate_audio: false,
    });
  });

  it("uses the runtime 8-second default for task-routed Veo references", async () => {
    await runGenerate([
      "generate",
      "video",
      "preserve the character",
      "--estimate",
      "--no-audio",
      "--ref",
      "character.png",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "google-veo3.1",
      type: "video",
      duration_seconds: 8,
      generate_audio: false,
    });
  });

  it("includes MiniMax H3 reference inputs in an exact estimate", async () => {
    await runGenerate([
      "generate",
      "video",
      "preserve the references",
      "--estimate",
      "--model",
      "minimax-h3",
      "--duration",
      "10",
      "--ref",
      "one.png",
      "--ref",
      "two.png",
      "--ref-video",
      "movement.mp4",
      "--ref-video-seconds",
      "4",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "minimax-h3",
      type: "video",
      duration_seconds: 10,
      reference_image_count: 2,
      reference_video_duration_seconds: 4,
    });
  });

  it("estimates FLUX 3 with its quality tier and resolution", async () => {
    await runGenerate([
      "generate",
      "video",
      "a red panda on a mossy log",
      "--estimate",
      "--model",
      "flux-3",
      "--duration",
      "12",
      "--resolution",
      "1080p",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "flux-3",
      type: "video",
      duration_seconds: 12,
      resolution: "1080p",
    });
  });

  it("estimates the FLUX 3 draft tier without leaking reference fields", async () => {
    await runGenerate([
      "generate",
      "video",
      "same shot, cheap pass",
      "--estimate",
      "--model",
      "flux-3",
      "--quality",
      "draft",
      "--duration",
      "5",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "flux-3",
      type: "video",
      duration_seconds: 5,
      quality: "draft",
    });
  });

  it("counts a Grok 1.5 first frame without leaking reference fields", async () => {
    await runGenerate([
      "generate",
      "video",
      "animate this frame",
      "--estimate",
      "--model",
      "grok-imagine-video-1.5",
      "--start-image",
      "frame.png",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "grok-imagine-video-1.5",
      type: "video",
      duration_seconds: 6,
      reference_image_count: 1,
    });
  });

  it("estimates Seed Audio through its dedicated audio model", async () => {
    await runGenerate(["generate", "audio", "calm narration", "--estimate"]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "seed-audio-1.0",
      type: "audio",
    });
  });

  it("maps Seed Audio references and generation options exactly", async () => {
    mocks.callTool.mockResolvedValueOnce({
      audioUrl: "https://cdn.example.test/out.wav",
    });

    await runGenerate([
      "generate",
      "audio",
      "Continue",
      "@Audio1",
      "under",
      "the",
      "dialogue",
      "--ref-audio",
      "https://cdn.example.test/one.wav",
      "--ref-audio",
      "https://cdn.example.test/two.mp3",
      "--voice",
      "voice_custom_1",
      "--format",
      "ogg_opus",
      "--sample-rate",
      "48000",
      "--speed",
      "0.8",
      "--volume",
      "1.2",
      "--pitch",
      "-3",
      "--project",
      "project_1",
      "--session",
      "session_1",
      "--idempotency-key",
      "123e4567-e89b-12d3-a456-426614174000",
    ]);

    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("generate_audio", {
      prompt: "Continue @Audio1 under the dialogue",
      voice: "voice_custom_1",
      audio_urls: [
        "https://cdn.example.test/one.wav",
        "https://cdn.example.test/two.mp3",
      ],
      output_format: "ogg_opus",
      sample_rate: 48000,
      speed: 0.8,
      volume: 1.2,
      pitch: -3,
      project_id: "project_1",
      session_id: "session_1",
      idempotency_key: "123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("rejects an invalid Seed Audio idempotency key before calling MCP", async () => {
    await expect(
      runGenerate([
        "generate",
        "audio",
        "calm narration",
        "--idempotency-key",
        "not-a-uuid",
      ]),
    ).rejects.toThrow("--idempotency-key must be a valid UUID");

    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rejects Seed Audio image and audio references together before calling MCP", async () => {
    await expect(
      runGenerate([
        "generate",
        "audio",
        "Use the references",
        "--ref-audio",
        "https://cdn.example.test/one.wav",
        "--image",
        "https://cdn.example.test/frame.png",
      ]),
    ).rejects.toThrow("--image and --ref-audio cannot be used together");

    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rejects more than three Seed Audio references before calling MCP", async () => {
    await expect(
      runGenerate([
        "generate",
        "audio",
        "Blend the references",
        "--ref-audio",
        "https://cdn.example.test/one.wav",
        "--ref-audio",
        "https://cdn.example.test/two.wav",
        "--ref-audio",
        "https://cdn.example.test/three.wav",
        "--ref-audio",
        "https://cdn.example.test/four.wav",
      ]),
    ).rejects.toThrow("Seed Audio accepts at most 3 --ref-audio values");

    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});
