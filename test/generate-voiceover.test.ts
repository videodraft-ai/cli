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

import {
  parseVoiceoverMode,
  registerGenerateCommands,
} from "../src/commands/generate.js";

const originalPinnedSession = process.env.VIDEODRAFT_SESSION;

async function runGenerate(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json");
  program.exitOverride();
  registerGenerateCommands(program);
  await program.parseAsync(args, { from: "user" });
}

describe("parseVoiceoverMode", () => {
  it("accepts standard and turbo, and leaves an omitted mode unset", () => {
    expect(parseVoiceoverMode("standard", "--mode")).toBe("standard");
    expect(parseVoiceoverMode("turbo", "--mode")).toBe("turbo");
    expect(parseVoiceoverMode(undefined, "--mode")).toBeUndefined();
  });

  it.each(["fast", "Turbo", "", "eleven-v4"])("rejects %j", (mode) => {
    expect(() => parseVoiceoverMode(mode, "--voice-mode")).toThrow(
      "--voice-mode must be one of: standard, turbo.",
    );
  });
});

describe("generate voiceover --mode", () => {
  beforeEach(() => {
    delete process.env.VIDEODRAFT_SESSION;
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({
      speech_url: "https://cdn.test/voiceover.mp3",
      duration: 1.4,
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalPinnedSession === undefined) {
      delete process.env.VIDEODRAFT_SESSION;
    } else {
      process.env.VIDEODRAFT_SESSION = originalPinnedSession;
    }
    vi.restoreAllMocks();
  });

  it("sends turbo to generate_voiceover as mode", async () => {
    await runGenerate([
      "generate",
      "voiceover",
      "Hello",
      "there.",
      "--voice",
      "kPzsL2i3teMYv0FxEYQ6",
      "--mode",
      "turbo",
    ]);

    expect(mocks.callTool).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith("generate_voiceover", {
      text: "Hello there.",
      voice_id: "kPzsL2i3teMYv0FxEYQ6",
      mode: "turbo",
    });
  });

  it("sends an explicit standard, and nothing when --mode is left out", async () => {
    await runGenerate(["generate", "voiceover", "Hi", "--mode", "standard"]);
    expect(mocks.callTool).toHaveBeenLastCalledWith("generate_voiceover", {
      text: "Hi",
      mode: "standard",
    });

    await runGenerate(["generate", "voiceover", "Hi"]);
    const [, args] = mocks.callTool.mock.calls.at(-1)!;
    expect(args).toEqual({ text: "Hi" });
  });

  it("refuses an unknown mode before generating", async () => {
    await expect(
      runGenerate(["generate", "voiceover", "Hi", "--mode", "fast"]),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: "--mode must be one of: standard, turbo.",
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});
