import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { registerPipelineCommands } from "../src/commands/pipeline.js";
import {
  seedanceRetryPreservedHint,
  seedanceUnresolvedSubmissionHint,
} from "../src/core/errors.js";

function buildPipelineProgram(): Command {
  const program = new Command();
  program.option("--json");
  registerPipelineCommands(program);
  return program;
}

async function runPipeline(args: string[]): Promise<void> {
  await buildPipelineProgram().parseAsync(args, { from: "user" });
}

describe("GPT Image 2.5 shot estimates", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.callTool.mockResolvedValueOnce({
      storyboard: {
        settings: {
          defaultImageModel: "gpt-image-2.5-sunburst",
          aspectRatio: "4:5",
        },
        scenes: [{}, {}],
      },
    });
    mocks.callTool.mockResolvedValueOnce({ cost: 10 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the project's actual defaults for omitted model and aspect", async () => {
    await runPipeline([
      "shots",
      "project-1",
      "--quality",
      "xhigh",
      "--resolution",
      "2K",
      "--estimate",
    ]);
    expect(mocks.callTool).toHaveBeenNthCalledWith(2, "get_model_costs", {
      model_id: "gpt-image-2.5-sunburst",
      aspect_ratio: "4:5",
      type: "image",
      quality: "xhigh",
      resolution: "2K",
    });
  });

  it("keeps explicit caller choices above project defaults", async () => {
    await runPipeline([
      "shots",
      "project-1",
      "--model",
      "gpt-image-2.5-flare",
      "--ar",
      "1:1",
      "--quality",
      "high",
      "--estimate",
    ]);
    expect(mocks.callTool).toHaveBeenNthCalledWith(2, "get_model_costs", {
      model_id: "gpt-image-2.5-flare",
      aspect_ratio: "1:1",
      type: "image",
      quality: "high",
    });
  });
});

describe("produce --mode full_video", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({ status: "production" });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("keeps the retired real-people flags out of help", () => {
    const produce = buildPipelineProgram().commands.find(
      (command) => command.name() === "produce",
    );
    const help = produce!.helpInformation();

    expect(help).toContain("--no-auto-videos");
    expect(help).not.toContain("real-people");
  });

  it.each(["--allow-real-people", "--no-allow-real-people"])(
    "accepts the retired %s flag and sends nothing for it",
    async (flag) => {
      await runPipeline(["produce", "project_1", "--mode", "full_video", flag]);

      expect(mocks.callTool).toHaveBeenCalledOnce();
      expect(mocks.callTool).toHaveBeenCalledWith("produce_project", {
        project_id: "project_1",
        mode: "full_video",
      });
    },
  );

  it("marks a partial hosted submission as unsuccessful for automation", async () => {
    mocks.callTool.mockResolvedValue({
      status: "partial",
      failed_segments: [{ scene_index: 0, error: "boom" }],
    });

    await runPipeline(["produce", "project_1", "--mode", "full_video"]);

    expect(process.exitCode).toBe(1);
  });
});

describe("produce --voice-mode", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({ status: "production" });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the ElevenLabs narration mode as voice_mode", async () => {
    await runPipeline([
      "produce",
      "project_1",
      "--voice",
      "elevenlabs-kPzsL2i3teMYv0FxEYQ6",
      "--voice-mode",
      "turbo",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("produce_project", {
      project_id: "project_1",
      voice_id: "elevenlabs-kPzsL2i3teMYv0FxEYQ6",
      voice_mode: "turbo",
    });
  });

  it("omits voice_mode by default so the server default (standard) applies", async () => {
    await runPipeline(["produce", "project_1"]);

    const [, args] = mocks.callTool.mock.calls[0]!;
    expect(args).not.toHaveProperty("voice_mode");
  });

  it("refuses an unknown mode before producing anything", async () => {
    await expect(
      runPipeline(["produce", "project_1", "--voice-mode", "fast"]),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: "--voice-mode must be one of: standard, turbo.",
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});

describe("partial-run guidance hints", () => {
  it("says a rejection that spent nothing can simply be run again", () => {
    expect(
      seedanceRetryPreservedHint({
        status: "partial",
        failed_segments: [
          {
            scene_index: 0,
            error: "Byteplus integration not configured",
            retry_preserved: true,
          },
        ],
      }),
    ).toContain("run the same command again");
  });

  it("warns not to resubmit an unacknowledged submission", () => {
    expect(
      seedanceUnresolvedSubmissionHint({
        status: "partial",
        failed_segments: [
          {
            scene_index: 0,
            error: "Network error calling /api/seedance2-reference-to-video",
            submission_unresolved: true,
          },
        ],
      }),
    ).toContain("do not resubmit");
  });

  it("stays quiet on an ordinary failure", () => {
    const result = {
      status: "partial",
      failed_segments: [{ scene_index: 0, error: "boom" }],
    };
    expect(seedanceRetryPreservedHint(result)).toBeUndefined();
    expect(seedanceUnresolvedSubmissionHint(result)).toBeUndefined();
  });

  it("tolerates a result with no failed_segments", () => {
    expect(
      seedanceRetryPreservedHint({ status: "production" }),
    ).toBeUndefined();
    expect(
      seedanceUnresolvedSubmissionHint({ status: "production" }),
    ).toBeUndefined();
  });
});
