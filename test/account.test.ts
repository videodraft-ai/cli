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
    }),
  };
});

import { registerAccountCommands } from "../src/commands/account.js";

const originalPinnedSession = process.env.VIDEODRAFT_SESSION;

beforeEach(() => {
  delete process.env.VIDEODRAFT_SESSION;
});

afterEach(() => {
  if (originalPinnedSession === undefined) {
    delete process.env.VIDEODRAFT_SESSION;
  } else {
    process.env.VIDEODRAFT_SESSION = originalPinnedSession;
  }
  vi.restoreAllMocks();
});

async function runAccount(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json");
  registerAccountCommands(program);
  await program.parseAsync(args, { from: "user" });
}

describe("costs --allow-real-people", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({ credits: 48 });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("forwards the Seedance pricing opt-in", async () => {
    await runAccount([
      "costs",
      "seedance-2.5",
      "--type",
      "video",
      "--duration",
      "10",
      "--allow-real-people",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith(
      "get_model_costs",
      expect.objectContaining({
        model_id: "seedance-2.5",
        type: "video",
        duration_seconds: 10,
        allow_real_people: true,
      }),
    );
  });

  it("forwards the Byteplus-only opt-out, and nothing by default", async () => {
    await runAccount([
      "costs",
      "seedance-2.5",
      "--type",
      "video",
      "--duration",
      "10",
      "--no-allow-real-people",
    ]);
    expect(mocks.callTool).toHaveBeenLastCalledWith(
      "get_model_costs",
      expect.objectContaining({ allow_real_people: false }),
    );

    await runAccount([
      "costs",
      "seedance-2.5",
      "--type",
      "video",
      "--duration",
      "10",
    ]);
    const [, args] = mocks.callTool.mock.calls.at(-1)!;
    expect(args.allow_real_people).toBeUndefined();
  });

  it("quotes GPT Image 2.5 with the selected aspect, resolution and quality", async () => {
    await runAccount([
      "costs",
      "gpt-image-2.5-flare",
      "--ar",
      "4:5",
      "--resolution",
      "2K",
      "--quality",
      "xhigh",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "gpt-image-2.5-flare",
      aspect_ratio: "4:5",
      resolution: "2K",
      quality: "xhigh",
    });
  });
});

describe("costs voiceover --mode", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({ cost: 4 });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("quotes ElevenLabs Turbo through the voiceover-turbo model id", async () => {
    await runAccount([
      "costs",
      "voiceover",
      "--type",
      "audio",
      "--chars",
      "800",
      "--mode",
      "turbo",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "voiceover-turbo",
      type: "audio",
      characters: 800,
    });
  });

  it("keeps the standard, cloned and turbo ids and never forwards the TTS mode", async () => {
    await runAccount(["costs", "voiceover", "--chars", "800"]);
    expect(mocks.callTool).toHaveBeenLastCalledWith("get_model_costs", {
      model_id: "voiceover",
      characters: 800,
    });

    await runAccount(["costs", "tts", "--chars", "800", "--mode", "standard"]);
    expect(mocks.callTool).toHaveBeenLastCalledWith("get_model_costs", {
      model_id: "tts",
      characters: 800,
    });

    await runAccount(["costs", "tts", "--mode", "turbo"]);
    expect(mocks.callTool).toHaveBeenLastCalledWith("get_model_costs", {
      model_id: "voiceover-turbo",
    });

    await runAccount(["costs", "voiceover-cloned", "--mode", "standard"]);
    expect(mocks.callTool).toHaveBeenLastCalledWith("get_model_costs", {
      model_id: "voiceover-cloned",
    });

    await runAccount(["costs", "voiceover-turbo", "--mode", "turbo"]);
    expect(mocks.callTool).toHaveBeenLastCalledWith("get_model_costs", {
      model_id: "voiceover-turbo",
    });
  });

  it.each<[string[], string]>([
    [["voiceover-cloned", "--mode", "turbo"], "have no Turbo mode"],
    [["custom-voice", "--mode", "turbo"], "have no Turbo mode"],
    [["voiceover-turbo", "--mode", "standard"], "already quotes Turbo"],
    [
      ["voiceover", "--mode", "generative"],
      "--mode for a voiceover estimate must be one of: standard, turbo.",
    ],
  ])("refuses costs %j", async (args, message) => {
    await expect(runAccount(["costs", ...args])).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(message),
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("still forwards --mode unchanged for other models", async () => {
    await runAccount([
      "costs",
      "topaz-upscale-video",
      "--type",
      "video",
      "--mode",
      "generative",
    ]);

    expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
      model_id: "topaz-upscale-video",
      type: "video",
      mode: "generative",
    });
  });
});

describe("sessions name", () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({
      session: { id: "session-1", name: "Purple Seal Rescue Short" },
      renamed: true,
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("names the current automatic connection session", async () => {
    await runAccount(["sessions", "name", "Purple Seal Rescue Short"]);

    expect(mocks.callTool).toHaveBeenCalledWith(
      "name_current_ai_studio_session",
      { name: "Purple Seal Rescue Short" },
    );
  });

  it("refuses to name a different session when an override is pinned", async () => {
    process.env.VIDEODRAFT_SESSION = "session-b";

    await expect(
      runAccount(["sessions", "name", "Purple Seal Rescue Short"]),
    ).rejects.toMatchObject({ name: "UsageError", exitCode: 2 });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});
