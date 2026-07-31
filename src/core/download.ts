/**
 * Download generated media to local files.
 *
 * Path templates (genmedia-style): {job_id} {index} {ext} {name}
 *   videodraft generate image "..." --download "./out/{job_id}_{index}.{ext}"
 * A template without placeholders and without an extension is treated as a
 * directory: <dir>/<job_id>_<index>.<ext>.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { CliError } from "./errors.js";
import { DEFAULT_BASE_URL } from "./config.js";

const execFileAsync = promisify(execFile);

export interface DownloadedFile {
  url: string;
  path: string;
  bytes: number;
  /** Downscaled view copy in <dir>/previews/ (images over the size threshold
   *  only). Agents should inspect this instead of the full-res original —
   *  every full-res image an agent views is re-sent with each later message
   *  of its chat. Best-effort: absent when preview generation failed or was
   *  skipped. The original at `path` is always the deliverable. */
  preview?: string;
}

/** Image formats worth a preview. GIFs are excluded (animation would be
 *  flattened) and videos are inspected frame-wise by other tooling. */
const PREVIEW_SOURCE_RE = /\.(png|jpe?g|webp|tiff?)$/i;
/** Under this size the original is already cheap to view — no preview. */
const PREVIEW_SKIP_BYTES = 500 * 1024;
/** Fits every current vision model's input cap (~1568-2048px). */
const PREVIEW_MAX_DIM = 1536;
const PREVIEW_JPEG_QUALITY = 85;
/** Next.js image-optimizer width — must be one of the app's configured
 *  device sizes (defaults include 1080). */
const PREVIEW_CDN_WIDTH = 1080;

/** Preview extensions any route can produce — the invalidation set. */
const PREVIEW_EXTS = ["jpg", "webp", "png"] as const;

/** The original's FULL name (extension included) is kept and the preview
 *  extension appended — `shot.png` → `previews/shot.png.jpg` — so two
 *  originals differing only by extension can never collide on one preview. */
export function previewPathFor(originalPath: string, ext = "jpg"): string {
  return path.join(
    path.dirname(originalPath),
    "previews",
    `${path.basename(originalPath)}.${ext}`,
  );
}

/** Remove every preview variant of an original. Called before regeneration —
 *  and when the current download no longer qualifies for one — so an agent
 *  can never inspect a preview of a PREVIOUS file that lived at this path.
 *  A missing previews/ dir or file is a no-op. */
function invalidatePreviews(originalPath: string): void {
  for (const ext of PREVIEW_EXTS) {
    try {
      fs.rmSync(previewPathFor(originalPath, ext), { force: true });
    } catch {
      // Best-effort — stale-preview removal must never fail the download.
    }
  }
}

export function shouldWritePreview(originalPath: string, bytes: number): boolean {
  return PREVIEW_SOURCE_RE.test(originalPath) && bytes >= PREVIEW_SKIP_BYTES;
}

/** Both writers land through a temp file + atomic rename: a failed run can
 *  never leave a truncated preview (agents trust anything under previews/),
 *  and never clobbers a valid preview from an earlier download. */
function tempPreviewPath(previewPath: string): string {
  return `${previewPath}.tmp-${process.pid}`;
}

function commitPreview(tmpPath: string, previewPath: string): boolean {
  try {
    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
      fs.renameSync(tmpPath, previewPath);
      return true;
    }
  } catch {
    // fall through to cleanup
  }
  fs.rmSync(tmpPath, { force: true });
  return false;
}

/** Local downscale via sips (bundled with macOS; ~100ms for a 6MB PNG). */
async function writePreviewWithSips(originalPath: string, previewPath: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const tmp = tempPreviewPath(previewPath);
  try {
    // sips infers nothing from --out's name, so the extension-less tmp is
    // fine. Timeout: normal runs take ~100ms; a pathological image must not
    // hang the CLI after the download already succeeded.
    await execFileAsync(
      "sips",
      [
        "-Z", String(PREVIEW_MAX_DIM),
        "-s", "format", "jpeg",
        "-s", "formatOptions", String(PREVIEW_JPEG_QUALITY),
        originalPath,
        "--out", tmp,
      ],
      { timeout: 10_000 },
    );
  } catch {
    fs.rmSync(tmp, { force: true });
    return false;
  }
  return commitPreview(tmp, previewPath);
}

/** Consecutive CDN-variant failures this process. After
 *  `PREVIEW_CDN_MAX_CONSECUTIVE_FAILURES` the route is skipped for the rest
 *  of the run — when the optimizer is unreachable, a multi-output job must
 *  not pay the fetch timeout once per file. A success resets the counter. */
let cdnPreviewConsecutiveFailures = 0;
const PREVIEW_CDN_MAX_CONSECUTIVE_FAILURES = 2;
const PREVIEW_CDN_TIMEOUT_MS = 10_000;

/** Test-only: the breaker is process-lifetime state. */
export function resetPreviewCdnBreakerForTests(): void {
  cdnPreviewConsecutiveFailures = 0;
}

/** Network fallback: the webapp's image optimizer serves resized WebP (or
 *  JPEG, depending on negotiation) for cdn.videodraft.ai sources (allowlisted
 *  in its Next config). Returns the written path — extension follows the
 *  response content-type so the file is never mislabeled. */
async function writePreviewFromCdn(
  sourceUrl: string,
  originalPath: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  let host: string;
  try {
    host = new URL(sourceUrl).hostname;
  } catch {
    return undefined;
  }
  if (host !== "cdn.videodraft.ai") return undefined;
  if (cdnPreviewConsecutiveFailures >= PREVIEW_CDN_MAX_CONSECUTIVE_FAILURES) return undefined;
  const variant = `${DEFAULT_BASE_URL}/_next/image?url=${encodeURIComponent(sourceUrl)}&w=${PREVIEW_CDN_WIDTH}&q=75`;
  let res: Response;
  try {
    res = await fetchImpl(variant, {
      headers: { Accept: "image/webp,image/jpeg,image/*" },
      signal: AbortSignal.timeout(PREVIEW_CDN_TIMEOUT_MS),
    });
  } catch (err) {
    cdnPreviewConsecutiveFailures++;
    throw err;
  }
  if (!res.ok || !res.body) {
    cdnPreviewConsecutiveFailures++;
    return undefined;
  }
  cdnPreviewConsecutiveFailures = 0;
  const contentType = res.headers.get("content-type") ?? "";
  const ext = contentType.includes("webp")
    ? "webp"
    : contentType.includes("jpeg") || contentType.includes("jpg")
      ? "jpg"
      : contentType.includes("png")
        ? "png"
        : "webp";
  const previewPath = previewPathFor(originalPath, ext);
  const tmp = tempPreviewPath(previewPath);
  try {
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
  } catch {
    fs.rmSync(tmp, { force: true });
    return undefined;
  }
  return commitPreview(tmp, previewPath) ? previewPath : undefined;
}

/**
 * Best-effort preview emission next to a downloaded image. Never throws and
 * never touches the original — a preview failure must not fail the download.
 * Returns the preview path, or undefined when skipped/failed.
 */
export async function writePreview(
  originalPath: string,
  sourceUrl: string,
  bytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  if (!PREVIEW_SOURCE_RE.test(originalPath)) return undefined;
  // An image landed at this path — any preview of the PREVIOUS file that
  // lived here is stale now, including when the new file is too small to
  // earn a replacement (or generation below fails, leaving none).
  invalidatePreviews(originalPath);
  if (!shouldWritePreview(originalPath, bytes)) return undefined;
  try {
    const jpgPath = previewPathFor(originalPath, "jpg");
    fs.mkdirSync(path.dirname(jpgPath), { recursive: true });
    if (await writePreviewWithSips(originalPath, jpgPath).catch(() => false)) {
      return jpgPath;
    }
    const cdnPath = await writePreviewFromCdn(sourceUrl, originalPath, fetchImpl).catch(
      () => undefined,
    );
    if (cdnPath) return cdnPath;
  } catch {
    // Optimization only — swallow everything.
  }
  return undefined;
}

export function extFromUrl(url: string, fallback = "bin"): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).replace(/^\./, "");
    return ext || fallback;
  } catch {
    return fallback;
  }
}

export function renderTemplate(
  template: string,
  vars: { job_id?: string; index: number; ext: string; name?: string },
): string {
  const hasPlaceholders = /\{(job_id|index|ext|name)\}/.test(template);
  if (!hasPlaceholders) {
    const looksLikeFile = path.extname(template) !== "";
    if (looksLikeFile) {
      // Concrete filename: suffix the index for multi-output jobs.
      if (vars.index > 0) {
        const ext = path.extname(template);
        return `${template.slice(0, -ext.length)}_${vars.index}${ext}`;
      }
      return template;
    }
    return path.join(template, `${vars.job_id ?? vars.name ?? "output"}_${vars.index}.${vars.ext}`);
  }
  return template
    .replaceAll("{job_id}", vars.job_id ?? "job")
    .replaceAll("{index}", String(vars.index))
    .replaceAll("{ext}", vars.ext)
    .replaceAll("{name}", vars.name ?? "output");
}

export async function downloadUrl(
  url: string,
  destPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadedFile> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok || !res.body) {
    throw new CliError(`Download failed (HTTP ${res.status}): ${url}`);
  }
  fs.mkdirSync(path.dirname(path.resolve(destPath)), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(destPath));
  const bytes = fs.statSync(destPath).size;
  return { url, path: destPath, bytes };
}

/** Human-mode "saved …" line, pointing agents at the preview when one exists. */
export function savedLine(file: DownloadedFile): string {
  return file.preview
    ? `saved ${file.path} (inspect via preview: ${file.preview})`
    : `saved ${file.path}`;
}

export async function downloadOutputs(
  urls: string[],
  template: string,
  vars: { job_id?: string; name?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadedFile[]> {
  const files: DownloadedFile[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    const dest = renderTemplate(template, {
      job_id: vars.job_id,
      name: vars.name,
      index: i,
      ext: extFromUrl(url),
    });
    const file = await downloadUrl(url, dest, fetchImpl);
    const preview = await writePreview(file.path, url, file.bytes, fetchImpl);
    if (preview) file.preview = preview;
    files.push(file);
  }
  return files;
}
