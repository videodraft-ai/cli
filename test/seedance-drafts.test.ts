import { beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";
const mocks = vi.hoisted(() => ({ callTool: vi.fn() }));
vi.mock("../src/cli/context.js", async () => ({
  ...(await vi.importActual<typeof import("../src/cli/context.js")>(
    "../src/cli/context.js",
  )),
  buildContext: () => ({
    client: mocks,
    out: { json: true },
    flags: { json: true },
  }),
}));
import { registerGenerateCommands } from "../src/commands/generate.js";
import { registerJobCommands } from "../src/commands/jobs.js";
async function run(...args: string[]) {
  const program = new Command();
  registerGenerateCommands(program);
  registerJobCommands(program);
  await program.parseAsync(args, { from: "user" });
}
beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  mocks.callTool
    .mockReset()
    .mockImplementation(async (name) =>
      name === "get_tool_catalog"
        ? { tools: [{ name: "finalize_seedance_draft" }] }
        : { job_id: "job", creditCost: 305 },
    );
});
it("creates an explicit draft on a supporting server", async () => {
  await run(
    "generate",
    "video",
    "A boat",
    "--draft",
    "--no-wait",
    "--idempotency-key",
    "abc",
  );
  expect(mocks.callTool).toHaveBeenCalledWith(
    "generate_video",
    expect.objectContaining({
      model: "seedance-2.5",
      draft: true,
      resolution: "480p",
      idempotency_key: "abc",
    }),
  );
});
it("fails closed on older servers", async () => {
  mocks.callTool.mockResolvedValue({ tools: [] });
  await expect(
    run("generate", "video", "A boat", "--draft", "--no-wait"),
  ).rejects.toThrow(/support Seedance drafts/);
  expect(mocks.callTool).toHaveBeenCalledTimes(1);
});
it("leaves direct 480p calls unchanged", async () => {
  await run(
    "generate",
    "video",
    "A boat",
    "--model",
    "seedance-2.5",
    "--resolution",
    "480p",
    "--no-wait",
  );
  expect(mocks.callTool).toHaveBeenCalledTimes(1);
  const [name, args] = mocks.callTool.mock.calls[0]!;
  expect(name).toBe("generate_video");
  expect(args).not.toHaveProperty("draft");
  expect(args).not.toHaveProperty("idempotency_key");
});
it("quotes separately and submits final by VideoDraft generation ID", async () => {
  await run("finalize-draft", "abc", "--resolution", "4K", "--estimate");
  expect(mocks.callTool).toHaveBeenLastCalledWith("finalize_seedance_draft", {
    generation_id: "abc",
    resolution: "4k",
    estimate_only: true,
  });
  await run(
    "finalize-draft",
    "abc",
    "--resolution",
    "4K",
    "--idempotency-key",
    "render1",
    "--no-wait",
  );
  expect(mocks.callTool).toHaveBeenLastCalledWith("finalize_seedance_draft", {
    generation_id: "abc",
    resolution: "4k",
    idempotency_key: "render1",
  });
});
it("finds existing drafts using normal history", async () => {
  await run("generations", "--drafts");
  expect(mocks.callTool).toHaveBeenCalledWith(
    "list_recent_generations",
    expect.objectContaining({ drafts_only: true }),
  );
});

it.each([
  [8, 8],
  [undefined, 30],
])(
  "quotes a 480p draft with the reference billing duration",
  async (seconds, expected) => {
    await run(
      "generate",
      "video",
      "A boat",
      "--draft",
      "--estimate",
      "--duration",
      "5",
      "--ref-video",
      "https://cdn.example/boat.mp4",
      ...(seconds ? ["--ref-video-seconds", String(seconds)] : []),
    );
    expect(mocks.callTool).toHaveBeenLastCalledWith(
      "get_model_costs",
      expect.objectContaining({
        model_id: "seedance-2.5",
        duration_seconds: 5,
        resolution: "480p",
        reference_video_duration_seconds: expected,
      }),
    );
  },
);
