import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  parseKlingElements,
  registerGenerateCommands,
  resolveKlingElements,
} from "../src/commands/generate.js";
import { registerEditCommands } from "../src/commands/edit.js";

async function runGenerate(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json");
  registerGenerateCommands(program);
  await program.parseAsync(args, { from: "user" });
}

async function runEdit(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json");
  registerEditCommands(program);
  await program.parseAsync(args, { from: "user" });
}

const temporaryDirectories: string[] = [];

function temporaryMedia(name: string): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "videodraft-kling-elements-"),
  );
  temporaryDirectories.push(directory);
  const file = path.join(directory, name);
  fs.writeFileSync(file, "fixture");
  return file;
}

describe("Kling structured elements", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.uploadFile.mockReset();
    mocks.callTool.mockResolvedValue({
      job_id: "job_123",
      status: "submitted",
    });
    mocks.uploadFile.mockImplementation(async (_client, file: string) => ({
      url: `https://cdn.example.test/${path.basename(file)}`,
    }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    temporaryDirectories
      .splice(0)
      .forEach((directory) =>
        fs.rmSync(directory, { recursive: true, force: true }),
      );
  });

  it("normalizes camelCase and snake_case element JSON without coercing voice IDs", () => {
    expect(
      parseKlingElements([
        JSON.stringify([
          {
            frontalImageUrl: " front.png ",
            referenceImageUrls: [" left.png ", "right.png"],
            voiceId: "000123",
          },
          { video_url: "actor.mp4", voice_id: "voice-video" },
        ]),
      ]),
    ).toEqual([
      {
        frontal_image_url: "front.png",
        reference_image_urls: ["left.png", "right.png"],
        voice_id: "000123",
      },
      { video_url: "actor.mp4", voice_id: "voice-video" },
    ]);
  });

  it("loads element arrays from an @file JSON input", () => {
    const file = temporaryMedia("elements.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          frontalImageUrl: "front.png",
          referenceImageUrls: ["profile.png"],
          voiceId: "000123",
        },
      ]),
    );

    expect(parseKlingElements([`@${file}`])).toEqual([
      {
        frontal_image_url: "front.png",
        reference_image_urls: ["profile.png"],
        voice_id: "000123",
      },
    ]);
  });

  it("uploads every nested local element source and preserves its voice binding", async () => {
    const frontal = temporaryMedia("front.png");
    const reference = temporaryMedia("profile.png");
    const video = temporaryMedia("performance.mp4");

    const result = await resolveKlingElements(
      {
        client: { callTool: mocks.callTool } as any,
        out: { json: true, color: false, isTTY: false },
      } as any,
      [
        {
          frontal_image_url: frontal,
          reference_image_urls: [reference],
          voice_id: "000123",
        },
        { video_url: video, voice_id: "voice-video" },
      ],
    );

    expect(mocks.uploadFile).toHaveBeenCalledTimes(3);
    expect(result).toEqual([
      {
        frontal_image_url: "https://cdn.example.test/front.png",
        reference_image_urls: ["https://cdn.example.test/profile.png"],
        voice_id: "000123",
      },
      {
        video_url: "https://cdn.example.test/performance.mp4",
        voice_id: "voice-video",
      },
    ]);
  });

  it("maps a Kling 3.0 image element and its voice to generate_video", async () => {
    await runGenerate([
      "generate",
      "video",
      "@Element1 says welcome",
      "--model",
      "kling-3.0",
      "--start-image",
      "https://cdn.example.test/start.png",
      "--audio",
      "--element",
      JSON.stringify({
        frontal_image_url: "https://cdn.example.test/front.png",
        reference_image_urls: ["https://cdn.example.test/profile.png"],
        voice_id: "000123",
      }),
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_video", {
      prompt: "@Element1 says welcome",
      model: "kling-3.0",
      generate_audio: true,
      start_image_url: "https://cdn.example.test/start.png",
      elements: [
        {
          frontal_image_url: "https://cdn.example.test/front.png",
          reference_image_urls: ["https://cdn.example.test/profile.png"],
          voice_id: "000123",
        },
      ],
    });
  });

  it("maps a Kling O3 video element and its voice without requiring a start frame", async () => {
    await runGenerate([
      "generate",
      "video",
      "@Element1 performs",
      "--model",
      "kling-o3",
      "--audio",
      "--element",
      '{"video_url":"https://cdn.example.test/actor.mp4","voice_id":"voice-video"}',
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_video", {
      prompt: "@Element1 performs",
      model: "kling-o3",
      generate_audio: true,
      elements: [
        {
          video_url: "https://cdn.example.test/actor.mp4",
          voice_id: "voice-video",
        },
      ],
    });
  });

  it("rejects Turbo elements and Kling 3.0 elements without a start frame", async () => {
    const element = '{"video_url":"https://cdn.example.test/actor.mp4"}';
    await expect(
      runGenerate([
        "generate",
        "video",
        "perform",
        "--model",
        "kling-v3-turbo",
        "--element",
        element,
      ]),
    ).rejects.toThrow("does not support --element");
    await expect(
      runGenerate([
        "generate",
        "video",
        "perform",
        "--model",
        "kling-3.0",
        "--element",
        element,
      ]),
    ).rejects.toThrow("requires --start-image");
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rejects mixed element sources and empty image references", async () => {
    await expect(
      runGenerate([
        "generate",
        "video",
        "perform",
        "--model",
        "kling-o3",
        "--element",
        '{"video_url":"https://cdn.example.test/a.mp4","frontal_image_url":"https://cdn.example.test/front.png","reference_image_urls":["https://cdn.example.test/ref.png"]}',
      ]),
    ).rejects.toThrow("image fields or video_url, but not both");
    await expect(
      runGenerate([
        "generate",
        "video",
        "perform",
        "--model",
        "kling-o3",
        "--element",
        '{"frontal_image_url":"https://cdn.example.test/front.png","reference_image_urls":["  "]}',
      ]),
    ).rejects.toThrow("non-empty strings");
  });

  it("enforces Kling O3's reduced combined-reference cap with a video element", async () => {
    await expect(
      runGenerate([
        "generate",
        "video",
        "perform",
        "--model",
        "kling-o3",
        "--ref",
        "https://cdn.example.test/one.png",
        "--ref",
        "https://cdn.example.test/two.png",
        "--ref",
        "https://cdn.example.test/three.png",
        "--ref",
        "https://cdn.example.test/four.png",
        "--element",
        '{"video_url":"https://cdn.example.test/actor.mp4"}',
      ]),
    ).rejects.toThrow("at most 4 combined");
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("maps Kling 2.6 voice IDs as opaque strings with their prompt markers", async () => {
    await runGenerate([
      "generate",
      "video",
      "<<<voice_1>>> Welcome",
      "--model",
      "kling-2.6-pro",
      "--start-image",
      "https://cdn.example.test/host.png",
      "--audio",
      "--voice-id",
      "000123",
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("generate_video", {
      prompt: "<<<voice_1>>> Welcome",
      model: "kling-2.6-pro",
      generate_audio: true,
      start_image_url: "https://cdn.example.test/host.png",
      voice_ids: ["000123"],
    });
  });

  it("rejects missing, duplicate, and silent Kling 2.6 voice bindings", async () => {
    const base = [
      "generate",
      "video",
      "Hello",
      "--model",
      "kling-2.6-pro",
      "--start-image",
      "https://cdn.example.test/host.png",
    ];
    await expect(
      runGenerate([...base, "--voice-id", "voice-a"]),
    ).rejects.toThrow("must be cited in the prompt");
    await expect(
      runGenerate([
        ...base.slice(0, 2),
        "<<<voice_1>>> <<<voice_2>>> Hello",
        ...base.slice(3),
        "--voice-id",
        "voice-a",
        "--voice-id",
        "voice-a",
      ]),
    ).rejects.toThrow("cannot repeat");
    await expect(
      runGenerate([
        ...base.slice(0, 2),
        "<<<voice_1>>> Hello",
        ...base.slice(3),
        "--voice-id",
        "voice-a",
        "--no-audio",
      ]),
    ).rejects.toThrow("requires audio");
  });

  it("quotes the dedicated voice-control rate only when a voice is bound", async () => {
    mocks.callTool.mockResolvedValueOnce({ credits: 80 });
    await runGenerate([
      "generate",
      "video",
      "@Element1 speaks",
      "--model",
      "kling-3.0",
      "--start-image",
      "https://cdn.example.test/start.png",
      "--element",
      '{"video_url":"https://cdn.example.test/actor.mp4","voice_id":"voice-video"}',
      "--estimate",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "kling-3.0",
      type: "video",
      voice_control: true,
    });
  });

  it("maps the optional image-only motion element and selects video orientation", async () => {
    await runEdit([
      "edit",
      "motion",
      "https://cdn.example.test/character.png",
      "Apply the dance",
      "--motion-video",
      "https://cdn.example.test/dance.mp4",
      "--element",
      '{"frontal_image_url":"https://cdn.example.test/front.png","reference_image_urls":["https://cdn.example.test/profile.png"]}',
      "--no-wait",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_motion_control_video",
      {
        model: "kling-v3-motion-control",
        prompt: "Apply the dance",
        image_url: "https://cdn.example.test/character.png",
        motion_video_url: "https://cdn.example.test/dance.mp4",
        character_orientation: "video",
        keep_original_sound: true,
        element: {
          frontal_image_url: "https://cdn.example.test/front.png",
          reference_image_urls: ["https://cdn.example.test/profile.png"],
        },
      },
    );
  });
});
