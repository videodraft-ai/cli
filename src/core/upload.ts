/**
 * Local-file upload via the MCP two-step flow:
 *   create_media_upload → PUT bytes to the presigned upload_url → finalize_media_upload
 * The bytes go directly to GCS; they never pass through the MCP server.
 */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { CliError } from "./errors.js";
import type { VideoDraftClient } from "./rpc.js";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/L16",
  opus: "audio/opus",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

export function guessContentType(filename: string): string | undefined {
  const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
  return MIME_BY_EXT[ext];
}

export interface UploadResult {
  url: string;
  file_path?: string;
  [key: string]: unknown;
}

export async function uploadFile(
  client: VideoDraftClient,
  localPath: string,
  options: { contentType?: string; fetchImpl?: typeof fetch } = {},
): Promise<UploadResult> {
  return upload(client, localPath, options, false);
}

/** 3D uploads use their own server validation and artifact storage lane. */
export async function upload3DFile(
  client: VideoDraftClient,
  localPath: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<UploadResult> {
  if (path.extname(localPath).toLowerCase() !== ".glb") {
    throw new CliError(
      "3D rigging uploads require a self-contained .glb file.",
    );
  }
  return upload(
    client,
    localPath,
    { ...options, contentType: "model/gltf-binary" },
    true,
  );
}

async function upload(
  client: VideoDraftClient,
  localPath: string,
  options: { contentType?: string; fetchImpl?: typeof fetch },
  model3d: boolean,
): Promise<UploadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolved = path.resolve(localPath);
  if (!fs.existsSync(resolved)) {
    throw new CliError(`File not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new CliError(`Expected a file: ${resolved}`);
  }
  const filename = path.basename(resolved);
  const contentType = options.contentType ?? guessContentType(filename);
  if (!contentType) {
    throw new CliError(
      `Cannot infer media type for "${filename}". Pass --content-type (image/*, video/* or audio/*).`,
    );
  }

  const createTool = model3d ? "create_3d_upload" : "create_media_upload";
  const finalizeTool = model3d ? "finalize_3d_upload" : "finalize_media_upload";
  const created: any = await client.callTool(createTool, {
    filename,
    content_type: contentType,
  });
  const uploadUrl: string | undefined = created?.upload_url;
  const filePath: string | undefined = created?.file_path;
  if (!uploadUrl || !filePath) {
    throw new CliError(`${createTool} did not return upload_url/file_path.`);
  }

  // Stream the file to GCS rather than buffering it — a few-hundred-MB video
  // (a supported --ref-video / upscale-video input) would otherwise OOM. The
  // presigned PUT needs an exact Content-Length, so read it from the file size.
  const { size } = fs.statSync(resolved);
  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-length": String(size),
  };
  if (model3d) {
    const maxBytes = created?.max_bytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new CliError(
        "create_3d_upload did not return a valid max_bytes limit.",
      );
    }
    if (size > maxBytes) {
      throw new CliError(
        `3D upload is ${size} bytes; the server allows at most ${maxBytes} bytes.`,
      );
    }
    if (
      !created.headers ||
      typeof created.headers !== "object" ||
      Array.isArray(created.headers)
    ) {
      throw new CliError(
        "create_3d_upload did not return the required signed PUT headers.",
      );
    }
    for (const [name, value] of Object.entries(created.headers)) {
      if (typeof value !== "string")
        throw new CliError(
          `create_3d_upload returned an invalid ${name} header.`,
        );
      headers[name.toLowerCase()] = value;
    }
    // Keep every signed header, including GCS size/write-once constraints.
    // Content-Length always describes the bytes we will actually stream.
    headers["content-length"] = String(size);
    const range = /^(\d+),(\d+)$/.exec(
      headers["x-goog-content-length-range"] ?? "",
    );
    if (range && (size < Number(range[1]) || size > Number(range[2]))) {
      throw new CliError(
        `3D upload must contain between ${range[1]} and ${range[2]} bytes.`,
      );
    }
  }
  const putRes = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers,
    body: Readable.toWeb(
      fs.createReadStream(resolved),
    ) as unknown as ReadableStream,
    // Node/undici requires duplex:"half" when the body is a stream.
    duplex: "half",
    signal: AbortSignal.timeout(600_000),
  } as RequestInit & { duplex: "half" });
  if (!putRes.ok) {
    throw new CliError(
      `Upload PUT failed (HTTP ${putRes.status}). The presigned URL may have expired — retry.`,
    );
  }

  const finalized: any = await client.callTool(finalizeTool, {
    file_path: filePath,
    original_filename: filename,
  });
  const url: string | undefined = finalized?.url ?? finalized?.cdn_url;
  if (!url) {
    throw new CliError(`${finalizeTool} did not return a public url.`);
  }
  return { ...finalized, url, file_path: filePath };
}
