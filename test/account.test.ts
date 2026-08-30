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
