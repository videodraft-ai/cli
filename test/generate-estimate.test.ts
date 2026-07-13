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
});
