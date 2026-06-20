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
  gif: "image/gif",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
  mp3: "audio/mpeg",
  wav: "audio/wav",
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
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolved = path.resolve(localPath);
  if (!fs.existsSync(resolved)) {
    throw new CliError(`File not found: ${resolved}`);
  }
  const filename = path.basename(resolved);
  const contentType = options.contentType ?? guessContentType(filename);
  if (!contentType) {
    throw new CliError(
      `Cannot infer media type for "${filename}". Pass --content-type (image/*, video/* or audio/*).`,
    );
  }

  const created: any = await client.callTool("create_media_upload", {
    filename,
    content_type: contentType,
  });
  const uploadUrl: string | undefined = created?.upload_url;
  const filePath: string | undefined = created?.file_path;
  if (!uploadUrl || !filePath) {
    throw new CliError("create_media_upload did not return upload_url/file_path.");
  }

  // Stream the file to GCS rather than buffering it — a few-hundred-MB video
  // (a supported --ref-video / upscale-video input) would otherwise OOM. The
  // presigned PUT needs an exact Content-Length, so read it from the file size.
  const { size } = fs.statSync(resolved);
  const putRes = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers: { "content-type": contentType, "content-length": String(size) },
    body: Readable.toWeb(fs.createReadStream(resolved)) as unknown as ReadableStream,
    // Node/undici requires duplex:"half" when the body is a stream.
    duplex: "half",
    signal: AbortSignal.timeout(600_000),
  } as RequestInit & { duplex: "half" });
  if (!putRes.ok) {
    throw new CliError(`Upload PUT failed (HTTP ${putRes.status}). The presigned URL may have expired — retry.`);
  }

  const finalized: any = await client.callTool("finalize_media_upload", {
    file_path: filePath,
    original_filename: filename,
  });
  const url: string | undefined = finalized?.url ?? finalized?.cdn_url;
  if (!url) {
    throw new CliError("finalize_media_upload did not return a public url.");
  }
  return { ...finalized, url, file_path: filePath };
}
