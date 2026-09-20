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

describe("produce --allow-real-people", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({ status: "production" });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("documents the full_video scope and higher Fal-tier pricing", () => {
    const produce = buildPipelineProgram().commands.find(
      (command) => command.name() === "produce",
    );
    const option = produce?.options.find(
      (candidate) => candidate.long === "--allow-real-people",
    );

    expect(option?.description).toContain("full_video only");
    expect(option?.description).toContain("higher Fal-tier pricing");
  });

  it("forwards an explicit opt-in to produce_project", async () => {
    await runPipeline([
      "produce",
      "project_1",
      "--mode",
      "full_video",
      "--allow-real-people",
    ]);

    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith(
      "produce_project",
      expect.objectContaining({
        project_id: "project_1",
        mode: "full_video",
        allow_real_people: true,
      }),
    );
  });

  it("omits allow_real_people by default so the server default (true) applies", async () => {
    await runPipeline(["produce", "project_1", "--mode", "full_video"]);

    const [, args] = mocks.callTool.mock.calls[0]!;
    expect(args.allow_real_people).toBeUndefined();
  });

  it("forwards an explicit opt-out to produce_project", async () => {
    await runPipeline([
      "produce",
      "project_1",
      "--mode",
      "full_video",
      "--no-allow-real-people",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith(
      "produce_project",
      expect.objectContaining({
        project_id: "project_1",
        mode: "full_video",
        allow_real_people: false,
      }),
    );
  });

  it("marks a partial hosted submission as unsuccessful for automation", async () => {
    mocks.callTool.mockResolvedValue({
      status: "partial",
      code: "SEEDANCE_REAL_PERSON_OPT_IN_REQUIRED",
      retryable: true,
      retry_with: { allow_real_people: true },
    });

    await runPipeline(["produce", "project_1", "--mode", "full_video"]);

    expect(process.exitCode).toBe(1);
  });
});

describe("partial-run guidance hints", () => {
  it("says the real-person retry survives a rejection that spent nothing", () => {
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
    ).toContain("one real-person retry is still available");
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
