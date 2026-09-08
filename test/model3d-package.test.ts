import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadModel3DPackage,
  model3DPackageDirectory,
  normalizeThreeDArtifactFilename,
} from "../src/core/model3d.js";
import { prepare3DRequest } from "../src/core/model3d-request.js";
import { upload3DFile, uploadFile } from "../src/core/upload.js";
import type { VideoDraftClient } from "../src/core/rpc.js";

describe("3D artifact packages", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vd-3d-package-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("downloads all artifacts and rewrites glTF dependencies to unique local paths", async () => {
    const payload = {
      type: "model3d",
      status: "completed",
      asset_id: "asset",
      artifacts: [
        {
          id: "model",
          role: "model",
          url: "https://cdn.test/uuid.gltf",
          filename: "hero.gltf",
        },
        {
          id: "buffer",
          role: "other",
          url: "https://cdn.test/uuid.bin",
          filename: "hero.bin",
        },
        {
          id: "texture",
          role: "texture",
          url: "https://cdn.test/texture.png",
          filename: "textures/color.png",
        },
        {
          id: "unsafe",
          role: "other",
          url: "https://cdn.test/other.png",
          filename: "../../outside.png",
        },
      ],
    };
    const documents: Record<string, string> = {
      "https://cdn.test/uuid.gltf": JSON.stringify({
        buffers: [{ uri: "hero.bin" }],
        images: [{ uri: "textures/color.png" }],
      }),
      "https://cdn.test/uuid.bin": "buffer",
      "https://cdn.test/texture.png": "texture",
      "https://cdn.test/other.png": "other",
    };
    const fetcher = vi.fn(
      async (url: unknown) => new Response(documents[String(url)]!),
    ) as unknown as typeof fetch;
    const result = await downloadModel3DPackage(payload, root, fetcher);
    expect(result.downloaded_files).toHaveLength(4);
    expect(result.package_warnings).toEqual([]);
    const manifest = JSON.parse(fs.readFileSync(result.manifest_path, "utf8"));
    expect(manifest.complete).toBe(true);
    for (const artifact of manifest.artifacts) {
      expect(artifact.local_path.startsWith("..")).toBe(false);
      expect(
        fs.existsSync(path.join(result.package_directory, artifact.local_path)),
      ).toBe(true);
    }
    const gltf = JSON.parse(
      fs.readFileSync(path.join(result.package_directory, "hero.gltf"), "utf8"),
    );
    expect(
      fs.readFileSync(
        path.join(result.package_directory, gltf.buffers[0].uri),
        "utf8",
      ),
    ).toBe("buffer");
    expect(
      fs.readFileSync(
        path.join(result.package_directory, gltf.images[0].uri),
        "utf8",
      ),
    ).toBe("texture");
    expect(fs.existsSync(path.join(root, "..", "outside.png"))).toBe(false);
  });

  it("rewrites OBJ material and MTL texture dependencies after filename collisions", async () => {
    const payload = {
      asset_id: "obj",
      artifacts: [
        {
          id: "obj",
          role: "model",
          url: "https://cdn.test/hero.obj",
          filename: "hero.obj",
        },
        {
          id: "mtl",
          role: "material",
          url: "https://cdn.test/hero.mtl",
          filename: "hero.mtl",
        },
        {
          id: "a",
          role: "texture",
          url: "https://cdn.test/a.png",
          filename: "color.png",
        },
        {
          id: "b",
          role: "texture",
          url: "https://cdn.test/b.png",
          filename: "color.png",
        },
      ],
    };
    const body: Record<string, string> = {
      "hero.obj": "mtllib hero.mtl\n",
      "hero.mtl": "map_Kd https://cdn.test/b.png\n",
      "a.png": "a",
      "b.png": "b",
    };
    const fetcher = (async (url: unknown) =>
      new Response(body[String(url).split("/").at(-1)!]!)) as typeof fetch;
    const result = await downloadModel3DPackage(payload, root, fetcher);
    expect(result.package_warnings).toEqual([]);
    expect(
      fs.readFileSync(path.join(result.package_directory, "hero.mtl"), "utf8"),
    ).toContain("map_Kd color-1.png");
    expect(
      fs.readFileSync(
        path.join(result.package_directory, "color-1.png"),
        "utf8",
      ),
    ).toBe("b");
  });

  it("reports a missing dependency instead of claiming a complete package", async () => {
    const result = await downloadModel3DPackage(
      {
        asset_id: "missing",
        artifacts: [
          {
            id: "mesh",
            role: "model",
            url: "https://cdn.test/a.gltf",
            filename: "a.gltf",
          },
        ],
      },
      root,
      (async () =>
        new Response('{"buffers":[{"uri":"missing.bin"}]}')) as typeof fetch,
    );
    expect(result.package_warnings).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(result.manifest_path, "utf8")).complete,
    ).toBe(false);
  });

  it("surfaces omitted-format warnings while documenting the scope of package completeness", async () => {
    const warning = "FBX was omitted; use the returned self-contained GLB.";
    const result = await downloadModel3DPackage(
      {
        asset_id: "omitted",
        artifact_warnings: [warning],
        artifacts: [
          {
            id: "mesh",
            role: "model",
            url: "https://cdn.test/mesh.glb",
            filename: "mesh.glb",
          },
        ],
      },
      root,
      (async () => new Response("model")) as typeof fetch,
    );
    expect(result.package_warnings).toEqual([warning]);
    const manifest = JSON.parse(fs.readFileSync(result.manifest_path, "utf8"));
    expect(manifest.complete).toBe(true);
    expect(manifest.complete_scope).toBe("returned_artifacts");
    expect(manifest.artifact_warnings).toEqual([warning]);
    expect(manifest.warnings).toEqual([warning]);
  });

  it("rewrites MTL reflection maps with options to the local texture", async () => {
    const result = await downloadModel3DPackage(
      {
        asset_id: "reflection",
        artifacts: [
          {
            id: "material",
            role: "material",
            url: "https://cdn.test/mesh.mtl",
            filename: "mesh.mtl",
          },
          {
            id: "texture",
            role: "texture",
            url: "https://cdn.test/reflection.png",
            filename: "textures/reflection.png",
          },
        ],
      },
      root,
      (async (url: unknown) =>
        new Response(
          String(url).endsWith(".mtl")
            ? "refl -type sphere https://cdn.test/reflection.png\n"
            : "texture",
        )) as typeof fetch,
    );
    expect(
      fs.readFileSync(path.join(result.package_directory, "mesh.mtl"), "utf8"),
    ).toBe("refl -type sphere textures/reflection.png\n");
    expect(result.package_warnings).toEqual([]);
  });

  it("creates safe texture aliases for preserved FBX dependencies without overwriting another artifact", async () => {
    const payload = {
      asset_id: "fbx",
      artifacts: [
        {
          id: "mesh",
          role: "model",
          url: "https://cdn.test/hero.fbx",
          filename: "hero.fbx",
        },
        {
          id: "texture",
          role: "texture",
          url: "https://cdn.test/skin.png",
          filename: "skin.png",
          aliases: ["Textures/skin.png", "../../outside.png", "hero.fbx"],
        },
      ],
    };
    const result = await downloadModel3DPackage(
      payload,
      root,
      (async (url: unknown) =>
        new Response(
          String(url).endsWith(".fbx") ? "original-fbx" : "texture",
        )) as typeof fetch,
    );
    expect(
      fs.readFileSync(path.join(result.package_directory, "hero.fbx"), "utf8"),
    ).toBe("original-fbx");
    expect(
      fs.readFileSync(
        path.join(result.package_directory, "Textures", "skin.png"),
        "utf8",
      ),
    ).toBe("texture");
    expect(result.package_warnings).toHaveLength(2);
    const manifest = JSON.parse(fs.readFileSync(result.manifest_path, "utf8"));
    expect(manifest.complete).toBe(false);
    expect(manifest.artifacts[1].local_aliases).toEqual(["Textures/skin.png"]);
  });

  it("preserves Unicode mesh folders so original FBX texture aliases remain relative to the model", async () => {
    const payload = {
      asset_id: "unicode",
      artifacts: [
        {
          id: "mesh",
          role: "model",
          url: "https://cdn.test/mesh.fbx",
          filename: "人物/hero.fbx",
        },
        {
          id: "texture",
          role: "texture",
          url: "https://cdn.test/skin.png",
          filename: "skin.png",
          aliases: ["人物/Textures/肌.png"],
        },
      ],
    };
    const result = await downloadModel3DPackage(
      payload,
      root,
      (async () => new Response("asset")) as typeof fetch,
    );
    expect(
      fs.existsSync(path.join(result.package_directory, "人物", "hero.fbx")),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(result.package_directory, "人物", "Textures", "肌.png"),
      ),
    ).toBe(true);
    expect(result.package_warnings).toEqual([]);
  });

  it("preserves a previous download when downloading the same asset again", async () => {
    const payload = {
      asset_id: "again",
      artifacts: [
        {
          id: "mesh",
          role: "model",
          url: "https://cdn.test/a.glb",
          filename: "a.glb",
        },
      ],
    };
    const first = await downloadModel3DPackage(
      payload,
      root,
      (async () => new Response("original")) as typeof fetch,
    );
    const second = await downloadModel3DPackage(
      payload,
      root,
      (async () => new Response("new")) as typeof fetch,
    );
    expect(first.package_directory).not.toBe(second.package_directory);
    expect(fs.readFileSync(first.downloaded_files[0]!.path, "utf8")).toBe(
      "original",
    );
  });

  it("does not leave a completed manifest or partial file after a failed download", async () => {
    const payload = {
      asset_id: "failure",
      artifacts: [
        {
          id: "mesh",
          role: "model",
          url: "https://cdn.test/a.glb",
          filename: "a.glb",
        },
      ],
    };
    await expect(
      downloadModel3DPackage(
        payload,
        root,
        (async () =>
          new Response("unavailable", { status: 503 })) as typeof fetch,
      ),
    ).rejects.toThrow("503");
    expect(fs.readdirSync(path.join(root, "failure"))).toEqual([]);
  });

  it("streams local GLB bytes through the dedicated create/finalize tools", async () => {
    const filename = path.join(root, "character.glb");
    const contents = "glTF-mock-file-with-signed-headers";
    fs.writeFileSync(filename, contents);
    const callTool = vi.fn(async (tool: string) =>
      tool === "create_3d_upload"
        ? {
            upload_url: "https://storage.test/signed",
            file_path: "user/3d/uuid.glb",
            max_bytes: 256 * 1024 * 1024,
            headers: {
              "Content-Type": "model/gltf-binary",
              "x-goog-content-length-range": "20,268435456",
              "x-goog-if-generation-match": "0",
            },
          }
        : { url: "https://cdn.test/user/3d/uuid.glb" },
    );
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(init?.headers).toEqual({
        "content-type": "model/gltf-binary",
        "content-length": String(Buffer.byteLength(contents)),
        "x-goog-content-length-range": "20,268435456",
        "x-goog-if-generation-match": "0",
      });
      expect(await new Response(init?.body).text()).toBe(contents);
      return new Response(null, { status: 200 });
    });
    const result = await upload3DFile(
      { callTool } as unknown as VideoDraftClient,
      filename,
      { fetchImpl: fetcher as typeof fetch },
    );
    expect(callTool).toHaveBeenNthCalledWith(1, "create_3d_upload", {
      filename: "character.glb",
      content_type: "model/gltf-binary",
    });
    expect(callTool).toHaveBeenNthCalledWith(2, "finalize_3d_upload", {
      file_path: "user/3d/uuid.glb",
      original_filename: "character.glb",
    });
    expect(result.url).toBe("https://cdn.test/user/3d/uuid.glb");
  });

  it("rejects oversized 3D uploads before streaming or finalizing", async () => {
    const filename = path.join(root, "too-large.glb");
    fs.writeFileSync(filename, Buffer.alloc(65));
    const callTool = vi.fn(async () => ({
      upload_url: "https://storage.test/signed",
      file_path: "user/3d/uuid.glb",
      max_bytes: 64,
      headers: {
        "Content-Type": "model/gltf-binary",
        "x-goog-content-length-range": "20,64",
        "x-goog-if-generation-match": "0",
      },
    }));
    const fetcher = vi.fn();
    await expect(
      upload3DFile({ callTool } as unknown as VideoDraftClient, filename, {
        fetchImpl: fetcher as typeof fetch,
      }),
    ).rejects.toThrow("at most 64 bytes");
    expect(fetcher).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("keeps ordinary media uploads on their existing header contract", async () => {
    const filename = path.join(root, "image.png");
    fs.writeFileSync(filename, "image");
    const callTool = vi.fn(async (tool: string) =>
      tool === "create_media_upload"
        ? {
            upload_url: "https://storage.test/media",
            file_path: "user/img/uuid.png",
            headers: { "x-extra": "ignored" },
            max_bytes: 1,
          }
        : { url: "https://cdn.test/user/img/uuid.png" },
    );
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        "content-type": "image/png",
        "content-length": "5",
      });
      expect(await new Response(init?.body).text()).toBe("image");
      return new Response(null, { status: 200 });
    });
    await uploadFile({ callTool } as unknown as VideoDraftClient, filename, {
      fetchImpl: fetcher as typeof fetch,
    });
    expect(callTool).toHaveBeenNthCalledWith(2, "finalize_media_upload", {
      file_path: "user/img/uuid.png",
      original_filename: "image.png",
    });
  });

  it("uses media/3d by default and rejects a lossy single-file template", () => {
    expect(model3DPackageDirectory({ asset_id: "asset" }, true)).toBe(
      path.join("media", "3d", "asset"),
    );
    expect(() =>
      model3DPackageDirectory({ asset_id: "asset" }, "hero.glb"),
    ).toThrow("directory");
  });

  it("keeps byte-capped Unicode names idempotent while preserving the extension and collision suffix", () => {
    const original = `人物/${"🦊".repeat(100)}.glb`;
    const canonical = normalizeThreeDArtifactFilename(original);
    const collision = normalizeThreeDArtifactFilename(
      original,
      undefined,
      "-2",
    );
    expect(canonical.endsWith(".glb")).toBe(true);
    expect(collision.endsWith("-2.glb")).toBe(true);
    expect(
      Buffer.byteLength(path.posix.basename(canonical)),
    ).toBeLessThanOrEqual(180);
    expect(
      Buffer.byteLength(path.posix.basename(collision)),
    ).toBeLessThanOrEqual(180);
    expect(normalizeThreeDArtifactFilename(canonical)).toBe(canonical);
    expect(normalizeThreeDArtifactFilename(collision)).toBe(collision);
    expect(canonical.includes("�")).toBe(false);
  });

  it("downloads colliding long Unicode filenames without losing their GLB extension", async () => {
    const stem = "模型".repeat(80);
    const result = await downloadModel3DPackage(
      {
        asset_id: "long-names",
        artifacts: [
          {
            id: "a",
            role: "model",
            url: "https://cdn.test/a.glb",
            filename: `${stem}A.glb`,
          },
          {
            id: "b",
            role: "model",
            url: "https://cdn.test/b.glb",
            filename: `${stem}B.glb`,
          },
        ],
      },
      root,
      (async () => new Response("model")) as typeof fetch,
    );
    const filenames = result.downloaded_files.map((file) =>
      path.basename(file.path),
    );
    expect(new Set(filenames).size).toBe(2);
    expect(
      filenames.every(
        (filename) =>
          filename.endsWith(".glb") && Buffer.byteLength(filename) <= 180,
      ),
    ).toBe(true);
  });

  it("reuses resolved upload URLs for retries and rejects changed command inputs", async () => {
    const id = "046a4b3d-c2da-407a-bd85-3141256e6a9c";
    const resolve = vi.fn(async () => ({
      request_id: id,
      image_url: "https://cdn.test/original-upload.png",
    }));
    const first = await prepare3DRequest(
      "account/server",
      id,
      { refs: ["same"] },
      resolve,
      root,
    );
    const second = await prepare3DRequest(
      "account/server",
      id,
      { refs: ["same"] },
      resolve,
      root,
    );
    expect(second).toEqual({ args: first.args, reused: true });
    expect(resolve).toHaveBeenCalledOnce();
    await expect(
      prepare3DRequest(
        "account/server",
        id,
        { refs: ["changed"] },
        resolve,
        root,
      ),
    ).rejects.toThrow("different inputs");
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("uses the same journal for equivalent UUID casing without changing URL or path casing", async () => {
    const id = "046a4b3d-c2da-407a-bd85-3141256e6a9c";
    const project = "f59d3fb0-c61f-433c-9844-7a64bb4a752c";
    const asset = "b10928f3-a4bb-43d1-830a-08ee80f508d1";
    const url = "https://cdn.test/Textures/HeroABC.png?Signature=ABCdef";
    const localPath = "/Projects/Hero/FrontABC.png";
    const resolve = vi.fn(async () => ({
      request_id: id.toUpperCase(),
      project_id: project.toUpperCase(),
      asset_id: asset.toUpperCase(),
      image_url: url,
    }));
    const first = await prepare3DRequest(
      "account/server",
      id.toUpperCase(),
      {
        project_id: project.toUpperCase(),
        asset_id: asset.toUpperCase(),
        refs: [url, { path: localPath }],
      },
      resolve,
      root,
    );
    const second = await prepare3DRequest(
      "account/server",
      id,
      {
        project_id: project,
        asset_id: asset,
        refs: [url, { path: localPath }],
      },
      resolve,
      root,
    );
    expect(second.reused).toBe(true);
    expect(resolve).toHaveBeenCalledOnce();
    expect(first.args).toEqual({
      request_id: id,
      project_id: project,
      asset_id: asset,
      image_url: url,
    });
    const scopeDirectory = path.join(root, fs.readdirSync(root)[0]!);
    expect(fs.readdirSync(scopeDirectory)).toEqual([`${id}.json`]);
    await expect(
      prepare3DRequest(
        "account/server",
        id,
        {
          project_id: project,
          asset_id: asset,
          refs: [url.toLowerCase(), { path: localPath }],
        },
        resolve,
        root,
      ),
    ).rejects.toThrow("different inputs");
    expect(resolve).toHaveBeenCalledOnce();
  });
});
