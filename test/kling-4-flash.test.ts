/**
 * Kling 4.0 Flash: `generate video --model kling-4.0-flash` and
 * `edit video --model kling-4.0-flash-video-edit`. Flash mirrors Kling 4.0
 * with one prompt (no --segment), no --end-image, no element voices, 720p
 * only and 3-20 s, so those are refused before any MCP call.
 */
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
    intervalMs: 3_000,
    timeoutMs: 600_000,
    adaptive: true,
  }),
}));

import {
  KLING_4_CLI_TIERS,
  kling4EditTier,
  kling4GenerationTier,
  registerGenerateCommands,
} from "../src/commands/generate.js";
import { registerEditCommands } from "../src/commands/edit.js";

async function run(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerGenerateCommands(program);
  registerEditCommands(program);
  await program.parseAsync(args, { from: "user" });
}

function written(): string {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map((call) => String(call[0]))
    .join("");
}

const START = "https://example.com/start.png";
const IMAGE = "https://example.com/room.png";
const VIDEO = "https://example.com/move.mp4";
const SOURCE = "https://cdn.example.test/source.mp4";
const IMAGE_ELEMENT = {
  frontal_image_url: "https://example.com/hero.png",
  reference_image_urls: ["https://example.com/hero-side.png"],
};

beforeEach(() => {
  mocks.callTool
    .mockReset()
    .mockResolvedValue({ job_id: "job", status: "submitted" });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

describe("Kling 4.0 tiers", () => {
  it("describe Flash as the 720p, 3-20 s tier of Kling 4.0", () => {
    expect(KLING_4_CLI_TIERS.map((tier) => tier.model)).toEqual([
      "kling-4.0",
      "kling-4.0-flash",
    ]);
    const flash = kling4GenerationTier("kling-4.0-flash");
    expect(flash).toMatchObject({
      name: "Kling 4.0 Flash",
      editModel: "kling-4.0-flash-video-edit",
      maxSeconds: 20,
      resolutions: ["720p"],
      multiShot: false,
      endFrame: false,
      voices: false,
      maxCombinedVideoSeconds: 20,
    });
    expect(kling4EditTier("kling-4.0-flash-video-edit")).toBe(flash);
    expect(kling4GenerationTier("kling-4.0")).toMatchObject({
      maxSeconds: 30,
      resolutions: ["720p", "1080p"],
      multiShot: true,
      endFrame: true,
      voices: true,
    });
    expect(kling4GenerationTier("kling-o3")).toBeUndefined();
    expect(kling4EditTier("kling-4.0-flash")).toBeUndefined();
  });
});

describe("generate video --model kling-4.0-flash", () => {
  it("passes references, elements and 720p through to generate_video", async () => {
    await run([
      "generate",
      "video",
      "@Element1 walks into @Image1, moving like @Video1",
      "--model",
      "kling-4-flash",
      "--start-image",
      START,
      "--ref",
      IMAGE,
      "--ref-video",
      VIDEO,
      "--element",
      JSON.stringify(IMAGE_ELEMENT),
      "--element",
      JSON.stringify({ video_url: "https://example.com/actor.mp4" }),
      "--duration",
      "20",
      "--resolution",
      "720P",
      "--ar",
      "auto",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("generate_video", {
      prompt: "@Element1 walks into @Image1, moving like @Video1",
      model: "kling-4.0-flash",
      aspect_ratio: "auto",
      duration_seconds: 20,
      resolution: "720p",
      start_image_url: START,
      reference_images: [IMAGE],
      reference_videos: [VIDEO],
      elements: [IMAGE_ELEMENT, { video_url: "https://example.com/actor.mp4" }],
    });
  });

  it("sends a lone start frame as image-to-video, with no end frame", async () => {
    await run([
      "generate",
      "video",
      "The paper boat tips over the curb",
      "--model",
      "kling-4.0-flash",
      "--start-image",
      START,
      "--duration",
      "6",
      "--no-wait",
    ]);
    const [, args] = mocks.callTool.mock.calls[0]!;
    expect(args).toMatchObject({
      model: "kling-4.0-flash",
      start_image_url: START,
      duration_seconds: 6,
    });
    for (const key of [
      "end_image_url",
      "multi_prompt",
      "aspect_ratio",
      "resolution",
    ])
      expect(args).not.toHaveProperty(key);
  });

  it("leaves the length and resolution to the server's defaults", async () => {
    await run([
      "generate",
      "video",
      "A lighthouse at dusk",
      "--model",
      "kling-4.0-flash",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith("generate_video", {
      prompt: "A lighthouse at dusk",
      model: "kling-4.0-flash",
    });
  });

  it.each([
    ["--segment shots", ["--segment", "Wide on the harbor:5"], /one prompt/],
    [
      "an end frame",
      ["--start-image", START, "--end-image", "https://example.com/end.png"],
      /no --end-image/,
    ],
    [
      "an end frame without a start frame",
      ["--end-image", "https://example.com/end.png"],
      /no --end-image/,
    ],
    ["1080p", ["--resolution", "1080p"], /720p only/],
    ["4K", ["--resolution", "4k"], /720p only/],
    ["21 seconds", ["--duration", "21"], /from 3 to 20/],
    ["half seconds", ["--duration", "4.5"], /from 3 to 20/],
    ["2 seconds", ["--duration", "2"], /from 3 to 20/],
    ["--no-audio", ["--no-audio"], /audio is always on/],
    ["a quality tier", ["--quality", "pro"], /no quality tier/],
    ["auto duration", ["--auto-duration"], /auto duration/],
    [
      "an element voice",
      ["--element", JSON.stringify({ ...IMAGE_ELEMENT, voice_id: "voice-1" })],
      /takes no voices/,
    ],
    [
      "four video elements",
      [1, 2, 3, 4].flatMap((n) => [
        "--element",
        JSON.stringify({ video_url: `https://example.com/${n}.mp4` }),
      ]),
      /at most 3 video-backed/,
    ],
    [
      "six video clips",
      [
        ...[1, 2, 3, 4].flatMap((n) => [
          "--ref-video",
          `https://example.com/ref-${n}.mp4`,
        ]),
        ...[1, 2].flatMap((n) => [
          "--element",
          JSON.stringify({ video_url: `https://example.com/${n}.mp4` }),
        ]),
      ],
      /share 5 clips/,
    ],
    [
      "eleven images",
      [
        "--start-image",
        START,
        ...Array.from({ length: 10 }, (_, n) => [
          "--ref",
          `https://example.com/${n}.png`,
        ]).flat(),
      ],
      /at most 10 images/,
    ],
    [
      "a ratio in image-to-video",
      ["--start-image", START, "--ar", "9:16"],
      /follows --start-image's framing/,
    ],
  ])("refuses %s before calling MCP", async (_label, flags, message) => {
    await expect(
      run([
        "generate",
        "video",
        "A boat",
        "--model",
        "kling-4.0-flash",
        ...(flags as string[]),
        "--no-wait",
      ]),
    ).rejects.toThrow(message as RegExp);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("names Flash in its refusals and points to Kling 4.0", async () => {
    await expect(
      run([
        "generate",
        "video",
        "A boat",
        "--model",
        "kling-4.0-flash",
        "--start-image",
        START,
        "--end-image",
        "https://example.com/end.png",
      ]),
    ).rejects.toThrow(
      "kling-4.0-flash takes no --end-image. Use --start-image alone for image-to-video, or --model kling-4.0 for start and end frames.",
    );
    await expect(
      run([
        "generate",
        "video",
        "A boat",
        "--model",
        "kling-4.0-flash",
        "--duration",
        "25",
      ]),
    ).rejects.toThrow(
      "Kling 4.0 Flash --duration must be a whole second from 3 to 20.",
    );
  });

  it("quotes reference videos at 3 s each when their length is unknown", async () => {
    mocks.callTool.mockResolvedValue({ cost: 100, credits_per_second: 7 });
    await run([
      "generate",
      "video",
      "Match @Video1",
      "--model",
      "kling-4.0-flash",
      "--ref-video",
      VIDEO,
      "--element",
      JSON.stringify({ video_url: "https://example.com/actor.mp4" }),
      "--duration",
      "5",
      "--estimate",
    ]);
    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith(
      "get_model_costs",
      expect.objectContaining({
        model_id: "kling-4.0-flash",
        type: "video",
        duration_seconds: 5,
        reference_video_duration_seconds: 6,
      }),
    );
    expect(written()).toContain("kling-4.0-flash bills reference and element");
  });

  it("caps --ref-video-seconds at Flash's 20 s for an exact quote", async () => {
    mocks.callTool.mockResolvedValue({ cost: 100, credits_per_second: 7 });
    await run([
      "generate",
      "video",
      "Match @Video1",
      "--model",
      "kling-4.0-flash",
      "--ref-video",
      VIDEO,
      "--ref-video-seconds",
      "20",
      "--estimate",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "get_model_costs",
      expect.objectContaining({
        model_id: "kling-4.0-flash",
        reference_video_duration_seconds: 20,
      }),
    );
    mocks.callTool.mockClear();
    await expect(
      run([
        "generate",
        "video",
        "Match @Video1",
        "--model",
        "kling-4.0-flash",
        "--ref-video",
        VIDEO,
        "--ref-video-seconds",
        "21",
        "--estimate",
      ]),
    ).rejects.toThrow(/from 0 to 20 for kling-4.0-flash/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("is never picked without --model", async () => {
    // Elements beside a reference video select Kling 4.0, not Flash.
    await run([
      "generate",
      "video",
      "@Element1 matches @Video1",
      "--ref-video",
      VIDEO,
      "--element",
      JSON.stringify(IMAGE_ELEMENT),
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_video",
      expect.objectContaining({ model: "kling-4.0" }),
    );
  });

  it("still holds an automatically picked Kling 4.0 to its element limits", async () => {
    // Several video elements pick Kling 4.0 without --model; four are one
    // more than it takes.
    await expect(
      run([
        "generate",
        "video",
        "@Element1 meets @Element2",
        ...[1, 2, 3, 4].flatMap((n) => [
          "--element",
          JSON.stringify({ video_url: `https://example.com/${n}.mp4` }),
        ]),
        "--no-wait",
      ]),
    ).rejects.toThrow(
      "kling-4.0 accepts at most 3 video-backed --element entries.",
    );
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("keeps Kling 4.0's longer shots, end frame and 1080p", async () => {
    await run([
      "generate",
      "video",
      "The paper boat tips over the curb",
      "--model",
      "kling-4.0",
      "--start-image",
      START,
      "--end-image",
      "https://example.com/end.png",
      "--duration",
      "30",
      "--resolution",
      "1080p",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_video",
      expect.objectContaining({
        model: "kling-4.0",
        end_image_url: "https://example.com/end.png",
        duration_seconds: 30,
        resolution: "1080p",
      }),
    );
  });

  it("routes the Flash edit model with one --ref-video source to edit_video", async () => {
    await run([
      "generate",
      "video",
      "Make it snow on @Video1",
      "--model",
      "kling-4.0-flash-video-edit",
      "--ref-video",
      SOURCE,
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith("edit_video", {
      model: "kling-4.0-flash-video-edit",
      prompt: "Make it snow on @Video1",
      video_url: SOURCE,
    });
  });
});

describe("edit video --model kling-4.0-flash-video-edit", () => {
  it("sends references, image elements, an output length and 720p", async () => {
    await run([
      "edit",
      "video",
      SOURCE,
      "Put @Element1 in @Video1, styled like @Image1",
      "--model",
      "kling-4.0-flash-video-edit",
      "--element",
      JSON.stringify(IMAGE_ELEMENT),
      "--ref",
      IMAGE,
      "--duration",
      "20",
      "--resolution",
      "720p",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("edit_video", {
      elements: [IMAGE_ELEMENT],
      model: "kling-4.0-flash-video-edit",
      prompt: "Put @Element1 in @Video1, styled like @Image1",
      video_url: SOURCE,
      reference_images: [IMAGE],
      resolution: "720p",
      duration_seconds: 20,
    });
  });

  it("matches the source when no --duration is set", async () => {
    await run([
      "edit",
      "video",
      SOURCE,
      "Make it snow on @Video1",
      "--model",
      "kling-4.0-flash-video-edit",
      "--no-wait",
    ]);
    const [, args] = mocks.callTool.mock.calls[0]!;
    expect(args).toMatchObject({ model: "kling-4.0-flash-video-edit" });
    expect(args).not.toHaveProperty("duration_seconds");
    expect(args).not.toHaveProperty("resolution");
  });

  it.each([
    ["1080p", ["--resolution", "1080p"], /720p only/],
    ["21 seconds", ["--duration", "21"], /from 3 to 20/],
    ["half seconds", ["--duration", "4.5"], /from 3 to 20/],
    ["--preserve-audio", ["--preserve-audio"], /source-audio preservation/],
    ["a quality tier", ["--quality", "pro"], /kling-o3-video-ref-edit/],
    [
      "an element voice",
      ["--element", JSON.stringify({ ...IMAGE_ELEMENT, voice_id: "voice-1" })],
      /image-only elements and no voice_id/,
    ],
    [
      "a video element",
      ["--element", JSON.stringify({ video_url: VIDEO })],
      /image-only elements/,
    ],
    [
      "eight elements",
      Array.from({ length: 8 }, () => [
        "--element",
        JSON.stringify(IMAGE_ELEMENT),
      ]).flat(),
      /at most 7 --element/,
    ],
    [
      "eleven reference images",
      Array.from({ length: 11 }, (_, n) => [
        "--ref",
        `https://example.com/${n}.png`,
      ]).flat(),
      /at most 10 reference images/,
    ],
    [
      "sixteen inputs with the source",
      [
        ...Array.from({ length: 10 }, (_, n) => [
          "--ref",
          `https://example.com/${n}.png`,
        ]).flat(),
        ...Array.from({ length: 5 }, () => [
          "--element",
          JSON.stringify(IMAGE_ELEMENT),
        ]).flat(),
      ],
      /at most 15 inputs/,
    ],
  ])("refuses %s before calling MCP", async (_label, flags, message) => {
    await expect(
      run([
        "edit",
        "video",
        SOURCE,
        "Add rain to @Video1",
        "--model",
        "kling-4.0-flash-video-edit",
        ...(flags as string[]),
        "--no-wait",
      ]),
    ).rejects.toThrow(message as RegExp);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("quotes with --estimate and explains the source-plus-output billing", async () => {
    mocks.callTool.mockResolvedValue({ cost: 112, credits_per_second: 7 });
    await run([
      "edit",
      "video",
      SOURCE,
      "Add rain to @Video1",
      "--model",
      "kling-4.0-flash-video-edit",
      "--duration",
      "8",
      "--estimate",
    ]);
    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "kling-4.0-flash-video-edit",
      type: "video",
      duration_seconds: 8,
    });
    const output = written();
    expect(output).toContain("Kling 4.0 Flash Video Edit bills the source");
    expect(output).toContain(
      "videodraft costs kling-4.0-flash-video-edit --type video --ref-video-seconds <source seconds>",
    );
  });

  it("keeps Kling 4.0 Video Edit's 30 s and 1080p", async () => {
    await run([
      "edit",
      "video",
      SOURCE,
      "Add rain to @Video1",
      "--model",
      "kling-4.0-video-edit",
      "--duration",
      "30",
      "--resolution",
      "1080p",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "edit_video",
      expect.objectContaining({
        model: "kling-4.0-video-edit",
        duration_seconds: 30,
        resolution: "1080p",
      }),
    );
  });
});
