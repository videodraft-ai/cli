import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { buildCommandPath } from "../src/cli/command-path.js";

/** Build a real commander tree and return the leaf command preAction would receive. */
function resolve(argv: string[]): string {
  const program = new Command();
  program.name("videodraft").option("--token <t>").option("--json").exitOverride();
  let leaf = "help";
  program.hook("preAction", (_t, action) => {
    leaf = buildCommandPath(action as any);
  });
  program.command("whoami").action(() => {});
  const gen = program.command("generate");
  gen.command("video [p...]").option("--model <m>").action(() => {});
  program.parse(argv, { from: "user" });
  return leaf;
}

describe("buildCommandPath", () => {
  it("returns the registered command name, never an option value", () => {
    // The P1 case: a token passed as an option value must NOT become the command.
    expect(resolve(["--token", "vd_mcp_secret", "whoami"])).toBe("whoami");
  });

  it("joins nested command groups", () => {
    expect(resolve(["generate", "video", "a fox", "--model", "kling-v3-turbo"])).toBe("generate video");
  });

  it("never surfaces a prompt/positional value", () => {
    const path = resolve(["generate", "video", "vd_mcp_looks_like_a_token", "--model", "x"]);
    expect(path).toBe("generate video");
    expect(path).not.toContain("vd_mcp");
  });

  it("walks parents directly", () => {
    const root: any = { name: () => "videodraft", parent: null };
    const group: any = { name: () => "generate", parent: root };
    const leaf: any = { name: () => "video", parent: group };
    expect(buildCommandPath(leaf)).toBe("generate video");
    expect(buildCommandPath(null)).toBe("help");
  });
});
