/**
 * Download generated media to local files.
 *
 * Path templates (genmedia-style): {job_id} {index} {ext} {name}
 *   videodraft generate image "..." --download "./out/{job_id}_{index}.{ext}"
 * A template without placeholders and without an extension is treated as a
 * directory: <dir>/<job_id>_<index>.<ext>.
 */

import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { CliError } from "./errors.js";

export interface DownloadedFile {
  url: string;
  path: string;
  bytes: number;
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
    files.push(await downloadUrl(url, dest, fetchImpl));
  }
  return files;
}
