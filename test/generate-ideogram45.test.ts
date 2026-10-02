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
import { registerGenerateCommands } from "../src/commands/generate.js";
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
it("forwards the editing source, all four extra references, quality, count and seed zero", async () => {
  const refs = ["a", "b", "c", "d"].map(
    (id) => `https://example.test/${id}.png`,
  );
  await run([
    "generate",
    "image",
    "Change the sign",
    "--model",
    "ideogram-v4.5",
    "--source-image",
    "https://example.test/source.png",
    ...refs.flatMap((ref) => ["--ref", ref]),
    "--quality",
    "low",
    "--edit-precision",
    "regular",
    "--num",
    "8",
    "--seed",
    "0",
    "--no-wait",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "generate_image",
    expect.objectContaining({
      model: "ideogram-v4.5",
      source_image: "https://example.test/source.png",
      reference_images: refs,
      quality: "low",
      edit_precision: "regular",
      num_images: 8,
      seed: 0,
    }),
  );
});
it("forwards precise masked editing with Auto geometry and no resolution", async () => {
  await run([
    "generate",
    "image",
    "Change the sign",
    "--model",
    "ideogram-v4.5",
    "--source-image",
    "https://example.test/source.png",
    "--mask",
    "https://example.test/mask.png",
    "--edit-precision",
    "high",
    "--ar",
    "auto",
    "--quality",
    "high",
    "--no-wait",
  ]);
  const [tool, args] = mocks.callTool.mock.calls.at(-1)!;
  expect(tool).toBe("generate_image");
  expect(args).toMatchObject({
    mask_url: "https://example.test/mask.png",
    edit_precision: "high",
    aspect_ratio: "auto",
    quality: "high",
  });
  expect(args.resolution).toBeUndefined();
  expect(args.enable_prompt_expansion).toBeUndefined();
});
it("preserves disabled expansion and explicit exact dimensions", async () => {
  await run([
    "generate",
    "image",
    "A poster",
    "--model",
    "ideogram-v4.5",
    "--prompt-expansion",
    "false",
    "--image-width",
    "1248",
    "--image-height",
    "832",
    "--no-wait",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "generate_image",
    expect.objectContaining({
      enable_prompt_expansion: false,
      image_width: 1248,
      image_height: 832,
    }),
  );
});
it("estimates regular Very Low editing from local source/reference paths without uploading", async () => {
  await run([
    "generate",
    "image",
    "Change it",
    "--model",
    "ideogram-v4.5",
    "--quality",
    "very_low",
    "--source-image",
    "missing-source.png",
    "--ref",
    "missing-ref.png",
    "--edit-precision",
    "regular",
    "--num",
    "2",
    "--estimate",
  ]);
  expect(mocks.callTool).toHaveBeenCalledOnce();
  expect(mocks.callTool).toHaveBeenCalledWith("get_model_costs", {
    model_id: "ideogram-v4.5",
    type: "image",
    quality: "very_low",
    reference_image_count: 2,
    edit_precision: "regular",
    num_images: 2,
  });
});
it("costs command carries editing mode and total content-image count", async () => {
  await run([
    "costs",
    "ideogram-v4.5",
    "--type",
    "image",
    "--quality",
    "very_low",
    "--ref-images",
    "1",
    "--edit-precision",
    "regular",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "get_model_costs",
    expect.objectContaining({
      model_id: "ideogram-v4.5",
      quality: "very_low",
      reference_image_count: 1,
      edit_precision: "regular",
    }),
  );
});
