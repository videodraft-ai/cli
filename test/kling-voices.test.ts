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

import { registerKlingVoiceCommands } from "../src/commands/kling-voices.js";

async function runVoices(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json");
  registerKlingVoiceCommands(program);
  await program.parseAsync(args, { from: "user" });
}

const temporaryDirectories: string[] = [];

function temporaryMedia(name: string): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "videodraft-kling-voice-"),
  );
  temporaryDirectories.push(directory);
  const file = path.join(directory, name);
  fs.writeFileSync(file, "fixture");
  return file;
}

describe("Kling voice library commands", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.uploadFile.mockReset();
    mocks.callTool.mockResolvedValue({ ok: true });
    mocks.uploadFile.mockResolvedValue({
      url: "https://cdn.example.test/speaker.wav",
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    temporaryDirectories
      .splice(0)
      .forEach((directory) =>
        fs.rmSync(directory, { recursive: true, force: true }),
      );
  });

  it("lists the account-scoped Kling voice library", async () => {
    await runVoices(["kling-voices", "list"]);
    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("list_kling_voices");
  });

  it("quotes creation without requiring consent or uploading the sample", async () => {
    mocks.callTool.mockResolvedValueOnce({ credits: 1 });
    await runVoices([
      "kling-voices",
      "create",
      "missing.wav",
      "--name",
      "Narrator",
      "--estimate",
    ]);

    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "kling-voice-create",
      type: "audio",
    });
  });

  it("requires explicit consent before any upload or provider call", async () => {
    await expect(
      runVoices([
        "kling-voices",
        "create",
        "https://cdn.example.test/speaker.wav",
        "--name",
        "Narrator",
      ]),
    ).rejects.toThrow("--confirm-consent is required");
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("creates a voice from a public sample with a trimmed name", async () => {
    await runVoices([
      "kling-voices",
      "create",
      "https://cdn.example.test/speaker.wav",
      "--name",
      "  Narrator  ",
      "--confirm-consent",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("create_kling_voice", {
      name: "Narrator",
      voice_url: "https://cdn.example.test/speaker.wav",
      consent_confirmed: true,
    });
  });

  it("uploads an allowed local sample before voice creation", async () => {
    const sample = temporaryMedia("speaker.wav");
    await runVoices([
      "kling-voices",
      "create",
      sample,
      "--name",
      "Narrator",
      "--confirm-consent",
    ]);

    expect(mocks.uploadFile).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("create_kling_voice", {
      name: "Narrator",
      voice_url: "https://cdn.example.test/speaker.wav",
      consent_confirmed: true,
    });
  });

  it("rejects unsupported local sample formats before upload", async () => {
    const sample = temporaryMedia("speaker.aac");
    await expect(
      runVoices([
        "kling-voices",
        "create",
        sample,
        "--name",
        "Narrator",
        "--confirm-consent",
      ]),
    ).rejects.toThrow("must be MP3, WAV, MP4, or MOV");
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rejects local samples larger than 50 MB before upload", async () => {
    const sample = temporaryMedia("speaker.wav");
    fs.truncateSync(sample, 50 * 1024 * 1024 + 1);
    await expect(
      runVoices([
        "kling-voices",
        "create",
        sample,
        "--name",
        "Narrator",
        "--confirm-consent",
      ]),
    ).rejects.toThrow("up to 50 MB");
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("deletes the saved record by its trimmed record ID", async () => {
    await runVoices(["kling-voices", "delete", "  record-123  "]);
    expect(mocks.callTool).toHaveBeenCalledWith("delete_kling_voice", {
      id: "record-123",
    });
  });
});
