import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  uploadFile: vi.fn(),
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

vi.mock("../src/core/upload.js", () => ({
  uploadFile: mocks.uploadFile,
}));

import {
  loadMusicPlan,
  musicPlanSeconds,
  parseMusicSections,
  registerGenerateCommands,
} from "../src/commands/generate.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function runGenerate(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json");
  program.exitOverride();
  registerGenerateCommands(program);
  await program.parseAsync(args, { from: "user" });
}

describe("parseMusicSections", () => {
  it("turns seconds, styles and text into plan chunks", () => {
    expect(
      parseMusicSections([
        "20|synthwave, female vocals|[Verse 1]\\nNeon rain | on the street",
        "8||[Outro] {fade out}",
      ]),
    ).toEqual([
      {
        text: "[Verse 1]\nNeon rain | on the street",
        duration_ms: 20_000,
        positive_styles: ["synthwave", "female vocals"],
      },
      {
        text: "[Outro] {fade out}",
        duration_ms: 8_000,
        positive_styles: [],
      },
    ]);
  });

  it("fills an empty length and empty text with defaults", () => {
    expect(parseMusicSections(["|lofi|", " 12 | | "])).toEqual([
      {
        text: "{instrumental}",
        duration_ms: 20_000,
        positive_styles: ["lofi"],
      },
      { text: "{instrumental}", duration_ms: 12_000, positive_styles: [] },
    ]);
  });

  it.each(["20|synthwave", "2|pop|[Intro]", "abc|pop|[Intro]", "130||x"])(
    "rejects %s",
    (spec) => {
      expect(() => parseMusicSections([spec])).toThrow(/--section/);
    },
  );
});

describe("loadMusicPlan", () => {
  it("accepts inline JSON, a bare chunk list, and a file", () => {
    const chunk = { text: "[Intro]", duration_ms: 5000, positive_styles: [] };
    expect(loadMusicPlan(JSON.stringify({ chunks: [chunk] })).plan).toEqual({
      chunks: [chunk],
    });
    expect(loadMusicPlan(JSON.stringify([chunk])).plan).toEqual({
      chunks: [chunk],
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-plan-"));
    const file = path.join(dir, "plan.json");
    fs.writeFileSync(file, JSON.stringify({ chunks: [chunk] }));
    const loaded = loadMusicPlan(file);
    expect(loaded.plan.chunks).toEqual([chunk]);
    expect(loaded.baseDir).toBe(dir);
  });

  it.each(["{not json", '{"chunks": []}', "missing-plan.json"])(
    "rejects %s",
    (value) => {
      expect(() => loadMusicPlan(value)).toThrow(/--plan/);
    },
  );
});

describe("musicPlanSeconds", () => {
  it("counts a chunk without a length as 20 seconds, like the server", () => {
    expect(
      musicPlanSeconds([
        { text: "[Intro]", positive_styles: [] },
        { text: "[Verse]", duration_ms: 12_500, positive_styles: [] },
        { duration_ms: null } as never,
      ]),
    ).toBe(52.5);
  });

  it.each<[unknown[], RegExp]>([
    [[{ duration_ms: 2_999 }], /duration_ms/],
    [[{ duration_ms: 120_001 }], /duration_ms/],
    [[{ duration_ms: 1_500.5 }], /duration_ms/],
    [[{ duration_ms: "20000" }], /duration_ms/],
    [Array.from({ length: 3 }, () => ({ duration_ms: 110_000 })), /330s/],
    [Array.from({ length: 31 }, () => ({ duration_ms: 3_000 })), /1 to 30/],
    [[], /1 to 30/],
  ])("rejects a plan the server would refuse (%#)", (chunks, message) => {
    expect(() => musicPlanSeconds(chunks as never)).toThrow(message);
  });
});

describe("generate music", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({
      success: true,
      audioUrl: "https://cdn.test/song.mp3",
    });
    mocks.uploadFile.mockReset();
    mocks.uploadFile.mockImplementation(async (_client, file: string) => ({
      url: `https://cdn.test/uploads/${path.basename(file)}`,
    }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  it("sends an ElevenLabs prompt with a retry-safe idempotency key", async () => {
    await runGenerate([
      "generate",
      "music",
      "an",
      "upbeat",
      "pop",
      "song",
      "--model",
      "elevenlabs-music",
      "--length",
      "45",
      "--instrumental",
      "--format",
      "mp3_44100_192",
    ]);

    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("generate_music", {
      prompt: "an upbeat pop song",
      model: "elevenlabs-music",
      length_seconds: 45,
      force_instrumental: true,
      output_format: "mp3_44100_192",
      idempotency_key: expect.stringMatching(UUID),
    });
  });

  it("builds a v2.5 composition plan from sections with a style reference", async () => {
    await runGenerate([
      "generate",
      "music",
      "--model",
      "elevenlabs-music-v2.5",
      "--section",
      "15|synthwave,120 bpm|[Intro] {synth swell}",
      "--section",
      "20|female vocals|[Verse 1]\\nNeon rain",
      "--ref-audio",
      "https://cdn.test/reference.mp3",
      "--ref-start",
      "1000",
      "--ref-end",
      "21000",
      "--ref-strength",
      "high",
      "--seed",
      "42",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_music", {
      model: "elevenlabs-music-v2.5",
      composition_plan: {
        chunks: [
          {
            text: "[Intro] {synth swell}",
            duration_ms: 15_000,
            positive_styles: ["synthwave", "120 bpm"],
            audio_reference: {
              audio_url: "https://cdn.test/reference.mp3",
              start_ms: 1000,
              end_ms: 21_000,
              strength: "high",
            },
          },
          {
            text: "[Verse 1]\nNeon rain",
            duration_ms: 20_000,
            positive_styles: ["female vocals"],
          },
        ],
      },
      seed: 42,
      idempotency_key: expect.stringMatching(UUID),
    });
  });

  it("uploads local reference audio named in a plan file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-music-"));
    fs.writeFileSync(path.join(dir, "ref.mp3"), "fake audio");
    const planFile = path.join(dir, "plan.json");
    fs.writeFileSync(
      planFile,
      JSON.stringify({
        chunks: [
          {
            text: "[Chorus]\nHold on",
            duration_ms: 30_000,
            positive_styles: ["anthemic rock"],
            audio_reference: { audio_url: "ref.mp3", strength: "low" },
          },
        ],
      }),
    );

    await runGenerate([
      "generate",
      "music",
      "--model",
      "elevenlabs-music-v2.5",
      "--plan",
      planFile,
    ]);

    expect(mocks.uploadFile).toHaveBeenCalledOnce();
    expect(mocks.uploadFile.mock.calls[0]?.[1]).toBe(path.join(dir, "ref.mp3"));
    const args = mocks.callTool.mock.calls[0]?.[1];
    expect(args.composition_plan.chunks[0].audio_reference).toEqual({
      audio_url: "https://cdn.test/uploads/ref.mp3",
      strength: "low",
    });
    expect(args).not.toHaveProperty("prompt");
  });

  it("resolves --ref-audio from the working directory, not the plan's", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vd-music-cwd-"));
    fs.mkdirSync(path.join(root, "plans"));
    fs.writeFileSync(path.join(root, "clip.mp3"), "fake audio");
    const planFile = path.join(root, "plans", "song.json");
    fs.writeFileSync(
      planFile,
      JSON.stringify({ chunks: [{ text: "[Intro]", positive_styles: [] }] }),
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      await runGenerate([
        "generate",
        "music",
        "--plan",
        planFile,
        "--ref-audio",
        "./clip.mp3",
        "--ref-strength",
        "high",
      ]);
    } finally {
      cwd.mockRestore();
    }

    expect(mocks.uploadFile).toHaveBeenCalledOnce();
    expect(mocks.uploadFile.mock.calls[0]?.[1]).toBe(
      path.join(root, "clip.mp3"),
    );
    const args = mocks.callTool.mock.calls[0]?.[1];
    expect(args.composition_plan.chunks[0].audio_reference).toEqual({
      audio_url: "https://cdn.test/uploads/clip.mp3",
      strength: "high",
    });
  });

  it("counts plan chunks without a length as 20 seconds in an estimate", async () => {
    mocks.callTool.mockResolvedValue({ cost: 120 });
    await runGenerate([
      "generate",
      "music",
      "--plan",
      JSON.stringify({
        chunks: [
          { text: "[Intro]" },
          { text: "[Verse]" },
          { text: "[Chorus]" },
          { text: "[Outro]" },
        ],
      }),
      "--estimate",
    ]);

    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "elevenlabs-music-v2.5",
      type: "audio",
      duration_seconds: 80,
    });
  });

  it("refuses to estimate a plan the server would reject", async () => {
    await expect(
      runGenerate([
        "generate",
        "music",
        "--plan",
        JSON.stringify([{ text: "[Intro]", duration_ms: 1_000 }]),
        "--estimate",
      ]),
    ).rejects.toThrow(/duration_ms/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("estimates a plan from the sum of its sections", async () => {
    mocks.callTool.mockResolvedValue({ cost: 60 });
    await runGenerate([
      "generate",
      "music",
      "--model",
      "elevenlabs-music-v2.5",
      "--section",
      "40|pop|[Verse]",
      "--section",
      "35|pop|[Chorus]",
      "--estimate",
    ]);

    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "elevenlabs-music-v2.5",
      type: "audio",
      duration_seconds: 75,
    });
  });

  it("uses v2.5 for a song plan when --model is left out", async () => {
    await runGenerate(["generate", "music", "--section", "15|pop|[Hook]"]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_music", {
      model: "elevenlabs-music-v2.5",
      composition_plan: {
        chunks: [
          { text: "[Hook]", duration_ms: 15_000, positive_styles: ["pop"] },
        ],
      },
      idempotency_key: expect.stringMatching(UUID),
    });
  });

  it("still lets Lyria ignore --length and --instrumental", async () => {
    await runGenerate([
      "generate",
      "music",
      "calm",
      "piano",
      "--length",
      "45",
      "--instrumental",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_music", {
      prompt: "calm piano",
      model: "lyria-3-clip-preview",
    });
  });

  it("sends Lyria 3.5 and project attachment through generate_music", async () => {
    await runGenerate([
      "generate",
      "music",
      "A two-minute song with Hindi vocals",
      "--model",
      "lyria-3.5",
      "--attach",
      "project-35",
      "--ref",
      "https://example.com/image.png",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith("generate_music", {
      prompt: "A two-minute song with Hindi vocals",
      model: "lyria-3.5",
      attach_to_project_id: "project-35",
      image_urls: ["https://example.com/image.png"],
    });
  });

  it("accepts image-only Lyria 3.5 requests", async () => {
    await runGenerate([
      "generate",
      "music",
      "--model",
      "lyria-3.5",
      "--ref",
      "https://example.com/ref.png",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith("generate_music", {
      model: "lyria-3.5",
      image_urls: ["https://example.com/ref.png"],
    });
  });

  it("rejects excessive Lyria references before uploading or calling MCP", async () => {
    const refs = Array.from({ length: 11 }, () => [
      "--ref",
      "photo.png",
    ]).flat();
    await expect(
      runGenerate([
        "generate",
        "music",
        "song",
        "--model",
        "lyria-3.5",
        ...refs,
      ]),
    ).rejects.toThrow(/at most 10/);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("keeps Lyria calls unchanged", async () => {
    await runGenerate(["generate", "music", "calm", "piano"]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_music", {
      prompt: "calm piano",
      model: "lyria-3-clip-preview",
    });
  });

  it.each([
    [["calm", "--format", "mp3_44100_128"], /only work with ElevenLabs Music/],
    [
      ["--model", "elevenlabs-music-v1", "--section", "10|pop|[Intro]"],
      /need elevenlabs-music-v2.5/,
    ],
    [
      [
        "song",
        "--model",
        "elevenlabs-music-v2.5",
        "--section",
        "10|pop|[Intro]",
      ],
      /replaces the prompt/,
    ],
    [
      ["song", "--model", "elevenlabs-music-v2.5", "--seed", "3"],
      /need a composition plan/,
    ],
    [["--model", "elevenlabs-music-v2.5"], /A prompt is required/],
    [
      ["song", "--model", "elevenlabs-music-v2.5", "--length", "900"],
      /--length/,
    ],
    [["song", "--model", "suno"], /Unknown music model/],
  ])("rejects %j", async (extra, message) => {
    await expect(
      runGenerate(["generate", "music", ...(extra as string[])]),
    ).rejects.toThrow(message as RegExp);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});
