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
import { registerPipelineCommands } from "../src/commands/pipeline.js";
async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerGenerateCommands(program);
  registerAccountCommands(program);
  registerPipelineCommands(program);
  await program.parseAsync(args, { from: "user" });
}
beforeEach(() => {
  mocks.callTool
    .mockReset()
    .mockResolvedValue({ job_id: "job", status: "submitted" });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());
it("forwards Seedream 5.5 background, resolution and references", async () => {
  await run([
    "generate",
    "image",
    "A sticker",
    "--model",
    "seedream-v5.5",
    "--resolution",
    "1.5K",
    "--background",
    "transparent",
    "--ref",
    "https://example.test/a.png",
    "--no-wait",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "generate_image",
    expect.objectContaining({
      model: "seedream-v5.5",
      resolution: "1.5K",
      background: "transparent",
      reference_images: ["https://example.test/a.png"],
    }),
  );
});
it("forwards Seedream 5.5 JPEG output", async () => {
  await run([
    "generate",
    "image",
    "A product",
    "--model",
    "seedream-v5.5",
    "--format",
    "jpeg",
    "--background",
    "opaque",
    "--watermark",
    "--no-wait",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "generate_image",
    expect.objectContaining({
      model: "seedream-v5.5",
      output_format: "jpeg",
      background: "opaque",
      watermark: true,
    }),
  );
});
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
it("quotes Seedream custom dimensions through both CLI estimate paths", async () => {
  await run([
    "costs",
    "seedream-v5.5",
    "--type",
    "image",
    "--image-width",
    "2048",
    "--image-height",
    "2048",
    "--ref-images",
    "2",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "get_model_costs",
    expect.objectContaining({
      model_id: "seedream-v5.5",
      image_width: 2048,
      image_height: 2048,
      reference_image_count: 2,
    }),
  );
  mocks.callTool.mockClear();
  await run([
    "generate",
    "image",
    "A boat",
    "--model",
    "seedream-v5.5",
    "--image-width",
    "2048",
    "--image-height",
    "2048",
    "--estimate",
  ]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "get_model_costs",
    expect.objectContaining({
      model_id: "seedream-v5.5",
      image_width: 2048,
      image_height: 2048,
    }),
  );
});
it("forwards Seedream batch options on shots and its estimate", async () => {
  const flags = [
    "--model",
    "seedream-v5.5",
    "--background",
    "opaque",
    "--format",
    "jpeg",
    "--image-width",
    "2048",
    "--image-height",
    "2048",
    "--watermark",
  ];
  await run(["shots", "project", ...flags, "--no-wait"]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "generate_shot_images",
    expect.objectContaining({
      model: "seedream-v5.5",
      background: "opaque",
      output_format: "jpeg",
      image_width: 2048,
      image_height: 2048,
      watermark: true,
    }),
  );
  mocks.callTool.mockClear();
  await run(["shots", "project", ...flags, "--estimate"]);
  expect(mocks.callTool).toHaveBeenCalledWith(
    "get_model_costs",
    expect.objectContaining({
      model_id: "seedream-v5.5",
      image_width: 2048,
      image_height: 2048,
      output_format: "jpeg",
      watermark: true,
    }),
  );
});

it("quotes Seedream grid and decoded shots separately without claiming an exact total", async () => {
  mocks.callTool.mockImplementation(async (name, args) => {
    if (name === "get_project") return { storyboard: { scenes: [{}, {}] } };
    if (name === "get_model_costs")
      return {
        model: "seedream-v5.5",
        unit_cost: args.reference_image_count === 1 ? 5 : 3,
      };
    throw new Error(`Unexpected tool ${name}`);
  });
  await run([
    "shots",
    "project",
    "--model",
    "Seedream 5.5",
    "--grid",
    "--estimate",
  ]);
  const quotes = mocks.callTool.mock.calls.filter(
    ([name]) => name === "get_model_costs",
  );
  expect(quotes).toHaveLength(2);
  expect(quotes[0]![1].reference_image_count).toBeUndefined();
  expect(quotes[1]![1].reference_image_count).toBe(1);
  const output = JSON.parse(
    vi.mocked(process.stdout.write).mock.calls.at(-1)![0] as string,
  );
  expect(output.per_image_costs.unit_cost).toBe(3);
  expect(output.grid_shot_costs.unit_cost).toBe(5);
  expect(output.note).toMatch(/Base-only/);
  expect(output.note).toMatch(/Extra references can increase/);
  expect(output.note).toMatch(/one target/);
});

it("uses a project's Seedream default and preserves a personal-key quote", async () => {
  mocks.callTool.mockImplementation(async (name) => {
    if (name === "get_project")
      return {
        storyboard: {
          settings: { defaultImageModel: "seedream-v5.5" },
          scenes: [],
        },
      };
    if (name === "get_model_costs")
      return {
        model: "seedream-v5.5",
        unit_cost: 0,
        byok: { active: true, provider: "pika" },
      };
    throw new Error(`Unexpected tool ${name}`);
  });
  await run(["shots", "project", "--grid", "--estimate"]);
  const quotes = mocks.callTool.mock.calls.filter(
    ([name]) => name === "get_model_costs",
  );
  expect(quotes).toHaveLength(2);
  expect(quotes[1]![1]).toMatchObject({
    model_id: "seedream-v5.5",
    reference_image_count: 1,
  });
  const output = JSON.parse(
    vi.mocked(process.stdout.write).mock.calls.at(-1)![0] as string,
  );
  expect(output.grid_shot_costs).toMatchObject({
    unit_cost: 0,
    byok: { active: true, provider: "pika" },
  });
});
