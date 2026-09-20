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
