import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  callToolBatch: vi.fn(),
  uploadFile: vi.fn(),
  upload3DFile: vi.fn(),
  prepare3DRequest: vi.fn(),
  json: true,
}));
vi.mock("../src/cli/context.js", async () => ({
  ...(await vi.importActual<typeof import("../src/cli/context.js")>(
    "../src/cli/context.js",
  )),
  buildContext: () => ({
    client: { callTool: mocks.callTool, callToolBatch: mocks.callToolBatch },
    out: { json: mocks.json, color: false, isTTY: false },
    flags: { json: true },
    baseUrl: "https://test.invalid",
    intervalMs: 1,
    timeoutMs: 1_000,
    adaptive: false,
  }),
}));
vi.mock("../src/core/upload.js", () => ({
  uploadFile: mocks.uploadFile,
  upload3DFile: mocks.upload3DFile,
}));
vi.mock("../src/core/model3d-request.js", async () => ({
  ...(await vi.importActual<typeof import("../src/core/model3d-request.js")>(
    "../src/core/model3d-request.js",
  )),
  prepare3DRequest: mocks.prepare3DRequest,
}));

import {
  register3DGenerationCommand,
  register3DAssetCommands,
  parse3DOptions,
} from "../src/commands/model3d.js";
import { registerJobCommands } from "../src/commands/jobs.js";
import { registerAccountCommands } from "../src/commands/account.js";

async function run(args: string[]): Promise<void> {
  const program = new Command().option("--json");
  register3DGenerationCommand(program.command("generate"));
  register3DAssetCommands(program);
  registerJobCommands(program);
  registerAccountCommands(program);
  await program.parseAsync(args, { from: "user" });
}

describe("3D CLI", () => {
  let temporary: string;
  beforeEach(() => {
    mocks.json = true;
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vd-3d-command-"));
    mocks.callTool.mockReset().mockResolvedValue({
      job_id: "job-3d",
      type: "model3d",
      status: "pending",
    });
    mocks.callToolBatch.mockReset();
    mocks.uploadFile
      .mockReset()
      .mockResolvedValue({ url: "https://cdn.test/reference.png" });
    mocks.upload3DFile
      .mockReset()
      .mockResolvedValue({ url: "https://cdn.test/upload.glb" });
    mocks.prepare3DRequest
      .mockReset()
      .mockImplementation(async (_scope, _id, _identity, resolve) => ({
        args: await resolve(),
        reused: false,
      }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.exitCode = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temporary, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("quotes local multi-view inputs without uploading or preparing a submit journal", async () => {
    const first = path.join(temporary, "front.png");
    const second = path.join(temporary, "back.png");
    fs.writeFileSync(first, "image");
    fs.writeFileSync(second, "image");
    await run([
      "generate",
      "3d",
      "--model",
      "tripo-h3.1",
      "--ref",
      first,
      "--ref",
      second,
      "--option",
      "texture=false",
      "--estimate",
    ]);
    expect(mocks.callTool).toHaveBeenCalledExactlyOnceWith("estimate_3d", {
      operation: "generate",
      model: "tripo-h3.1",
      input_mode: "multi_image",
      image_count: 2,
      options: { texture: false },
    });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.prepare3DRequest).not.toHaveBeenCalled();
  });

  it("preserves ordered references and every provider-native control on submit", async () => {
    const id = "046a4b3d-c2da-407a-bd85-3141256e6a9c";
    await run([
      "generate",
      "3d",
      "--model",
      "tripo-h3.1",
      "--ref",
      "https://cdn.test/front.png",
      "--ref",
      "https://cdn.test/back.png",
      "--options",
      '{"texture":true,"texture_quality":"detailed"}',
      "--option",
      "pbr=false",
      "--request-id",
      id,
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledExactlyOnceWith("generate_3d", {
      model: "tripo-h3.1",
      input_mode: "multi_image",
      image_urls: ["https://cdn.test/front.png", "https://cdn.test/back.png"],
      options: { texture: true, texture_quality: "detailed", pbr: false },
      request_id: id,
    });
    const printed = JSON.parse(
      String(vi.mocked(process.stdout.write).mock.calls.at(-1)?.[0]),
    );
    expect(printed.request_id).toBe(id);
  });

  it("uploads a local humanoid GLB through the 3D upload lane", async () => {
    const model = path.join(temporary, "hero.glb");
    fs.writeFileSync(model, "glTF");
    await run([
      "rig",
      "3d",
      model,
      "--option",
      'animation={"action_id":1}',
      "--no-wait",
    ]);
    expect(mocks.upload3DFile).toHaveBeenCalledOnce();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.callTool).toHaveBeenCalledWith(
      "rig_3d",
      expect.objectContaining({
        model_url: "https://cdn.test/upload.glb",
        options: { animation: { action_id: 1 } },
        request_id: expect.any(String),
      }),
    );
  });

  it("gets catalog schemas from the server", async () => {
    await run(["models", "3d"]);
    expect(mocks.callTool).toHaveBeenCalledExactlyOnceWith("get_3d_models");
  });

  it("renders the server's rigging prices in the human catalog", async () => {
    mocks.json = false;
    mocks.callTool.mockResolvedValue({
      models: [
        {
          id: "meshy-7",
          inputs: [
            {
              input_mode: "image",
              default_credits: 140,
              endpoint_id: "meshy/v7/image-to-3d",
            },
          ],
        },
      ],
      rigging: { credits: 20, animation_addon_credits: 12 },
    });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await run(["models", "3d"]);
    expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain(
      "Humanoid rigging: 20 credits; preset animation adds 12 credits.",
    );
  });

  it("retains artifact metadata and keeps a mesh out of output_media in wait", async () => {
    const payload = {
      type: "model3d",
      status: "completed",
      asset_id: "asset-3d",
      credits: 30,
      byok: false,
      output_urls: ["https://cdn.test/model.glb"],
      artifacts: [
        {
          id: "model",
          role: "model",
          url: "https://cdn.test/model.glb",
          filename: "hero.glb",
        },
        {
          id: "texture",
          role: "texture",
          url: "https://cdn.test/texture.png",
          filename: "basecolor.png",
        },
        {
          id: "preview",
          role: "preview",
          url: "https://cdn.test/preview.png",
          filename: "preview.png",
          content_type: "image/png",
        },
      ],
    };
    mocks.callToolBatch.mockResolvedValue([{ ok: true, result: payload }]);
    await run(["wait", "job-3d"]);
    const printed = JSON.parse(
      String(vi.mocked(process.stdout.write).mock.calls.at(-1)?.[0]),
    );
    expect(printed.asset_id).toBe("asset-3d");
    expect(printed.output_files).toHaveLength(3);
    expect(printed.output_media).toEqual([
      { kind: "image", url: "https://cdn.test/preview.png" },
    ]);
    expect(printed.credits).toBe(30);
  });

  it.each([
    ["status", "job-3d"],
    ["assets", "3d", "get", "asset-3d"],
    ["wait", "job-3d"],
  ])(
    "prints omitted-format warnings without requiring a download (%s)",
    async (...args: string[]) => {
      mocks.json = false;
      const warning =
        "The FBX format was omitted because its external texture references could not be packaged.";
      const payload = {
        type: "model3d",
        status: "completed",
        asset_id: "asset-3d",
        job_id: "job-3d",
        output_urls: ["https://cdn.test/mesh.glb"],
        artifact_warnings: [warning],
      };
      mocks.callTool.mockResolvedValue(payload);
      mocks.callToolBatch.mockResolvedValue([{ ok: true, result: payload }]);
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      await run(args);
      expect(
        stderr.mock.calls.map(([line]) => String(line)).join(""),
      ).toContain(warning);
    },
  );

  it("includes the request UUID in a failed submission for safe retry", async () => {
    mocks.callTool.mockRejectedValue(new Error("Connection lost"));
    await expect(
      run(["generate", "3d", "a robot", "--no-wait"]),
    ).rejects.toMatchObject({
      data: { request_id: expect.stringMatching(/^[a-f0-9-]{36}$/) },
    });
  });

  it("canonicalizes request/project UUIDs before generation journaling while preserving image URL casing", async () => {
    const id = "046a4b3d-c2da-407a-bd85-3141256e6a9c";
    const project = "f59d3fb0-c61f-433c-9844-7a64bb4a752c";
    const image = "https://cdn.test/Reference/HeroABC.png?Signature=ABCdef";
    await run([
      "generate",
      "3d",
      "--ref",
      image,
      "--request-id",
      id.toUpperCase(),
      "--project",
      project.toUpperCase(),
      "--no-wait",
    ]);
    expect(mocks.prepare3DRequest.mock.calls[0]?.[1]).toBe(id);
    expect(mocks.prepare3DRequest.mock.calls[0]?.[2]).toMatchObject({
      project_id: project,
      refs: [image],
    });
    expect(mocks.callTool).toHaveBeenCalledWith(
      "generate_3d",
      expect.objectContaining({
        request_id: id,
        project_id: project,
        image_url: image,
      }),
    );
  });

  it("canonicalizes saved asset UUIDs before rigging journaling and submission", async () => {
    const id = "046a4b3d-c2da-407a-bd85-3141256e6a9c";
    const asset = "b10928f3-a4bb-43d1-830a-08ee80f508d1";
    const project = "f59d3fb0-c61f-433c-9844-7a64bb4a752c";
    await run([
      "rig",
      "3d",
      "--asset",
      asset.toUpperCase(),
      "--project",
      project.toUpperCase(),
      "--request-id",
      id.toUpperCase(),
      "--no-wait",
    ]);
    expect(mocks.prepare3DRequest.mock.calls[0]?.[2]).toMatchObject({
      asset_id: asset,
      project_id: project,
    });
    expect(mocks.callTool).toHaveBeenCalledWith(
      "rig_3d",
      expect.objectContaining({
        request_id: id,
        asset_id: asset,
        project_id: project,
      }),
    );
  });

  it("rejects inconsistent input modes before calling MCP", async () => {
    await expect(
      run([
        "generate",
        "3d",
        "--input-mode",
        "image",
        "--ref",
        "https://cdn.test/a.png",
        "--ref",
        "https://cdn.test/b.png",
      ]),
    ).rejects.toThrow("exactly one");
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("quotes rigging without any source upload", async () => {
    await run(["rig", "3d", "--estimate", "--option", "height_meters=1.7"]);
    expect(mocks.callTool).toHaveBeenCalledExactlyOnceWith("estimate_3d", {
      operation: "rig",
      options: { height_meters: 1.7 },
    });
    expect(mocks.upload3DFile).not.toHaveBeenCalled();
  });
});

describe("provider option parsing", () => {
  it("preserves objects/arrays/false/zero and lets --option override JSON", () => {
    expect(
      parse3DOptions('{"pbr":true}', [
        "pbr=false",
        "seed=0",
        'animation={"action_id":1}',
        'formats=["glb","fbx"]',
      ]),
    ).toEqual({
      pbr: false,
      seed: 0,
      animation: { action_id: 1 },
      formats: ["glb", "fbx"],
    });
  });
  it.each(["null", "[]", "false", "not JSON"])(
    "rejects non-object options %s",
    (value) => expect(() => parse3DOptions(value)).toThrow(),
  );
});
