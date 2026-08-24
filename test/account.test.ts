import { beforeEach, describe, expect, it, vi } from "vitest";
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
