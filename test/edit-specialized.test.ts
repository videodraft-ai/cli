import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const mocks = vi.hoisted(() => ({ callTool: vi.fn() }));

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

import { registerEditCommands } from "../src/commands/edit.js";
import { registerGenerateCommands } from "../src/commands/generate.js";
import { registerAccountCommands } from "../src/commands/account.js";

async function runEdit(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json");
  registerEditCommands(program);
  await program.parseAsync(args, { from: "user" });
}

async function runGenerate(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json");
  registerGenerateCommands(program);
  await program.parseAsync(args, { from: "user" });
}

async function runAccount(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json");
  registerAccountCommands(program);
  await program.parseAsync(args, { from: "user" });
}

describe("specialized video edit commands", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({
      job_id: "job_123",
      status: "submitted",
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("uses Grok for a simple source-video edit when no model is named", async () => {
    await runEdit([
      "edit",
      "video",
      "https://cdn.example.test/source.mp4",
      "Add",
      "falling",
      "snow",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("edit_video", {
      model: "grok-imagine-video-edit",
      prompt: "Add falling snow",
      video_url: "https://cdn.example.test/source.mp4",
    });
  });

  it("preserves an explicitly selected Happy Horse edit model and refs", async () => {
    await runEdit([
      "edit",
      "video",
      "https://cdn.example.test/source.mp4",
      "Match",
      "the",
      "product",
      "--model",
      "happy-horse-video-edit",
      "--ref",
      "https://cdn.example.test/product.png",
      "--resolution",
      "1080p",
      "--preserve-audio",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("edit_video", {
      model: "happy-horse-video-edit",
      prompt: "Match the product",
      video_url: "https://cdn.example.test/source.mp4",
      reference_images: ["https://cdn.example.test/product.png"],
      resolution: "1080p",
      preserve_audio: true,
    });
  });

  it("preserves project shot scope for specialized video edits", async () => {
    await runEdit([
      "edit",
      "video",
      "https://cdn.example.test/source.mp4",
      "Change",
      "the",
      "weather",
      "--project",
      "project_123",
      "--scene",
      "2",
      "--shot",
      "1",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("edit_video", {
      model: "grok-imagine-video-edit",
      prompt: "Change the weather",
      video_url: "https://cdn.example.test/source.mp4",
      project_id: "project_123",
      scene_index: 2,
      shot_index: 1,
    });
  });

  it("uses Kling V3 for motion control by default", async () => {
    await runEdit([
      "edit",
      "motion",
      "https://cdn.example.test/character.png",
      "Apply",
      "the",
      "dance",
      "--motion-video",
      "https://cdn.example.test/dance.mp4",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_motion_control_video",
      {
        model: "kling-v3-motion-control",
        prompt: "Apply the dance",
        image_url: "https://cdn.example.test/character.png",
        motion_video_url: "https://cdn.example.test/dance.mp4",
        keep_original_sound: true,
      },
    );
  });

  it("preserves project shot scope for specialized motion control", async () => {
    await runEdit([
      "edit",
      "motion",
      "https://cdn.example.test/character.png",
      "Apply",
      "the",
      "dance",
      "--motion-video",
      "https://cdn.example.test/dance.mp4",
      "--project",
      "project_123",
      "--scene",
      "3",
      "--shot",
      "0",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_motion_control_video",
      {
        model: "kling-v3-motion-control",
        prompt: "Apply the dance",
        image_url: "https://cdn.example.test/character.png",
        motion_video_url: "https://cdn.example.test/dance.mp4",
        keep_original_sound: true,
        project_id: "project_123",
        scene_index: 3,
        shot_index: 0,
      },
    );
  });

  it("estimates the explicit edit model without submitting", async () => {
    mocks.callTool.mockResolvedValueOnce({ credits: 65 });

    await runEdit([
      "edit",
      "video",
      "https://cdn.example.test/source.mp4",
      "Change",
      "the",
      "weather",
      "--model",
      "kling-o3-video-ref-edit",
      "--quality",
      "standard",
      "--duration",
      "5",
      "--estimate",
    ]);

    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "kling-o3-video-ref-edit",
      type: "video",
      duration_seconds: 5,
      quality: "standard",
    });
  });

  it("routes an explicit edit model from generate video to edit_video", async () => {
    await runGenerate([
      "generate",
      "video",
      "Add",
      "rain",
      "--model",
      "grok-imagine-video-edit",
      "--ref-video",
      "https://cdn.example.test/source.mp4",
      "--project",
      "project_123",
      "--scene",
      "2",
      "--shot",
      "1",
      "--audio",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("edit_video", {
      model: "grok-imagine-video-edit",
      prompt: "Add rain",
      video_url: "https://cdn.example.test/source.mp4",
      preserve_audio: true,
      project_id: "project_123",
      scene_index: 2,
      shot_index: 1,
    });
  });

  it("routes an explicit motion model from generate video to motion control", async () => {
    await runGenerate([
      "generate",
      "video",
      "Apply",
      "the",
      "motion",
      "--model",
      "kling-2.6-motion-control",
      "--start-image",
      "https://cdn.example.test/character.png",
      "--ref-video",
      "https://cdn.example.test/motion.mp4",
      "--project",
      "project_123",
      "--scene",
      "3",
      "--shot",
      "0",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_motion_control_video",
      {
        model: "kling-2.6-motion-control",
        prompt: "Apply the motion",
        image_url: "https://cdn.example.test/character.png",
        motion_video_url: "https://cdn.example.test/motion.mp4",
        project_id: "project_123",
        scene_index: 3,
        shot_index: 0,
      },
    );
  });

  it("keeps Kling O3 Ref/Edit in reference-generation mode under generate video", async () => {
    await runGenerate([
      "generate",
      "video",
      "Match",
      "the",
      "performance",
      "--model",
      "kling-o3-video-ref-edit",
      "--ref-video",
      "https://cdn.example.test/performance.mp4",
      "--ref",
      "https://cdn.example.test/wardrobe.png",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_video", {
      model: "kling-o3-video-ref-edit",
      prompt: "Match the performance",
      reference_images: ["https://cdn.example.test/wardrobe.png"],
      reference_videos: ["https://cdn.example.test/performance.mp4"],
    });
  });

  it("rejects duration as an output override for motion control", async () => {
    await expect(
      runEdit([
        "edit",
        "motion",
        "https://cdn.example.test/character.png",
        "Apply",
        "the",
        "dance",
        "--motion-video",
        "https://cdn.example.test/dance.mp4",
        "--duration",
        "5",
        "--no-wait",
      ]),
    ).rejects.toThrow("estimate-only");
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rejects non-numeric edit duration before uploading or submitting", async () => {
    await expect(
      runEdit([
        "edit",
        "video",
        "https://cdn.example.test/source.mp4",
        "Change",
        "it",
        "--model",
        "wan-2.7-ref-edit",
        "--duration",
        "later",
        "--no-wait",
      ]),
    ).rejects.toMatchObject({
      name: "UsageError",
      exitCode: 2,
      message: "--duration must be a positive number.",
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("filters the video catalog by category", async () => {
    mocks.callTool.mockResolvedValueOnce({
      models: [
        { id: "gemini-omni-flash", category: "generation" },
        { id: "grok-imagine-video-edit", category: "video_edit" },
      ],
      categories: { generation: "new", video_edit: "edit" },
    });

    await runAccount(["models", "video", "--category", "video_edit"]);

    const written = vi
      .mocked(process.stdout.write)
      .mock.calls.map((call) => String(call[0]))
      .join("");
    expect(written).toContain("grok-imagine-video-edit");
    expect(written).not.toContain("gemini-omni-flash");
  });

  it("rejects reference inputs that a specialized edit would otherwise drop", async () => {
    await expect(
      runGenerate([
        "generate",
        "video",
        "Add",
        "rain",
        "--model",
        "grok-imagine-video-edit",
        "--ref-video",
        "https://cdn.example.test/source.mp4",
        "--ref-audio",
        "https://cdn.example.test/music.mp3",
        "--no-wait",
      ]),
    ).rejects.toMatchObject({
      name: "CliError",
      exitCode: 2,
      message: expect.stringContaining("does not support"),
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rejects unknown video catalog categories", async () => {
    await expect(
      runAccount(["models", "video", "--category", "editing"]),
    ).rejects.toMatchObject({
      name: "UsageError",
      exitCode: 2,
      message: expect.stringContaining('Unknown video category "editing"'),
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});
