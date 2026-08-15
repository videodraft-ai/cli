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

import { registerAvatarCommands } from "../src/commands/avatar.js";

async function runAvatar(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json");
  registerAvatarCommands(program);
  await program.parseAsync(args, { from: "user" });
}

describe("specialized avatar commands", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({
      job_id: "job_123",
      status: "submitted",
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("maps direct Fabric text mode to its dedicated MCP tool", async () => {
    await runAvatar([
      "avatar",
      "fabric",
      "https://cdn.example.test/avatar.png",
      "--text",
      "Hello from VideoDraft",
      "--voice-description",
      "warm narrator",
      "--resolution",
      "720p",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_veed_fabric_video", {
      image_url: "https://cdn.example.test/avatar.png",
      mode: "text",
      text: "Hello from VideoDraft",
      voice_description: "warm narrator",
      speed: "normal",
      resolution: "720p",
    });
  });

  it("maps existing video and audio to Sync Labs", async () => {
    await runAvatar([
      "avatar",
      "lipsync",
      "https://cdn.example.test/presenter.mp4",
      "--audio",
      "https://cdn.example.test/voice.mp3",
      "--sync-mode",
      "bounce",
      "--temperature",
      "0.7",
      "--active-speaker",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_sync_lipsync_video", {
      video_url: "https://cdn.example.test/presenter.mp4",
      audio_url: "https://cdn.example.test/voice.mp3",
      sync_mode: "bounce",
      temperature: 0.7,
      active_speaker: true,
    });
  });

  it("maps direct Fabric audio mode and fast processing", async () => {
    await runAvatar([
      "avatar",
      "fabric",
      "https://cdn.example.test/avatar.png",
      "--audio",
      "https://cdn.example.test/voice.mp3",
      "--speed",
      "fast",
      "--resolution",
      "480p",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_veed_fabric_video", {
      image_url: "https://cdn.example.test/avatar.png",
      mode: "audio",
      audio_url: "https://cdn.example.test/voice.mp3",
      speed: "fast",
      resolution: "480p",
    });
  });

  it("estimates Fabric without submitting a generation", async () => {
    mocks.callTool.mockResolvedValueOnce({ credits: 150 });

    await runAvatar([
      "avatar",
      "fabric",
      "https://cdn.example.test/avatar.png",
      "--audio",
      "https://cdn.example.test/voice.mp3",
      "--speed",
      "fast",
      "--resolution",
      "480p",
      "--audio-duration",
      "12",
      "--estimate",
    ]);

    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "veed-fabric-fast",
      type: "video",
      duration_seconds: 12,
      resolution: "480p",
    });
  });

  it("requires exactly one Fabric content source", async () => {
    await expect(
      runAvatar([
        "avatar",
        "fabric",
        "https://cdn.example.test/avatar.png",
        "--text",
        "Hello",
        "--audio",
        "https://cdn.example.test/voice.mp3",
      ]),
    ).rejects.toMatchObject({
      name: "UsageError",
      exitCode: 2,
      message: "Provide exactly one of --text or --audio.",
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rejects invalid specialized avatar options before submission", async () => {
    await expect(
      runAvatar([
        "avatar",
        "lipsync",
        "https://cdn.example.test/presenter.mp4",
        "--audio",
        "https://cdn.example.test/voice.mp3",
        "--sync-mode",
        "stretch",
        "--no-wait",
      ]),
    ).rejects.toThrow("--sync-mode must be");
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});
