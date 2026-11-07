import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
    intervalMs: 3000,
    timeoutMs: 600000,
    adaptive: true,
  }),
}));
import {
  gifImageOptions,
  registerGenerateCommands,
} from "../src/commands/generate.js";
import { registerAccountCommands } from "../src/commands/account.js";

async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerGenerateCommands(program);
  registerAccountCommands(program);
  await program.parseAsync(args, { from: "user" });
}

beforeEach(() => {
  mocks.callTool
    .mockReset()
    .mockResolvedValue({ job_id: "job", status: "submitted" });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

it("--gif with frames and speed sends GPT Image 2.6 GIF fields", async () => {
  await run([
    "generate",
    "image",
    "A bouncing ball, seamless loop",
    "--model",
    "gpt-image-2.6-flare",
    "--gif",
    "--frames",
    "12",
    "--frame-ms",
    "80",
    "--ar",
    "1:1",
    "--no-wait",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "generate_image",
    expect.objectContaining({
      model: "gpt-image-2.6-flare",
      output_format: "gif",
      frame_count: 12,
      frame_duration_ms: 80,
      aspect_ratio: "1:1",
    }),
  );
});

it("a frame flag implies --gif and --estimate quotes the GIF", async () => {
  mocks.callTool.mockResolvedValue({ cost: 5, unit_cost: 5 });
  await run([
    "generate",
    "image",
    "A waving flag",
    "--model",
    "gpt-image-2.6-sunburst",
    "--frames",
    "8",
    "--estimate",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "get_model_costs",
    expect.objectContaining({
      model_id: "gpt-image-2.6-sunburst",
      output_format: "gif",
      frame_count: 8,
    }),
  );
});

it("stills send no GIF fields", async () => {
  await run([
    "generate",
    "image",
    "A still bird",
    "--model",
    "gpt-image-2.6-flare",
    "--no-wait",
  ]);
  const args = mocks.callTool.mock.calls[0]![1];
  expect(args.output_format).toBeUndefined();
  expect(args.frame_count).toBeUndefined();
  expect(args.frame_duration_ms).toBeUndefined();
});

it("rejects out-of-range frames and speeds before calling MCP", () => {
  expect(gifImageOptions({ gif: true })).toEqual({ output_format: "gif" });
  expect(gifImageOptions({})).toEqual({});
  for (const frames of ["1", "17", "8.5", "x"])
    expect(() => gifImageOptions({ frames })).toThrow(/--frames/);
  for (const frameMs of ["10", "2001", "1.5"])
    expect(() => gifImageOptions({ frameMs })).toThrow(/--frame-ms/);
});
