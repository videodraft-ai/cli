/**
 * Canonical media descriptor emitted by every command that produces media, so a
 * consuming app (the VideoDraft desktop app) can render generated media
 * DETERMINISTICALLY — without scraping human text or guessing the kind from a
 * file extension. The kind is stated by us, never inferred downstream.
 *
 * Emitted ONLY as an `output_media` array field inside the `--json` document
 * (the documented machine channel — "agents parse --json"). Human / piped output
 * is intentionally left byte-identical to before, so terminal users, scripts and
 * `$(…)` captures that parse the human output are never affected.
 */

export interface MediaDescriptor {
  /** Explicit asset kind — stated here, never re-guessed by the consumer. */
  kind: "image" | "video" | "audio";
  /** The CDN / public URL of the generated asset. */
  url: string;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif", "avif", "svg"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac"]);

/** Kind from (1) the server's `type`, then (2) the CDN path category, then (3) the extension. */
function kindOf(url: string, typeHint?: string): MediaDescriptor["kind"] | null {
  const t = (typeHint ?? "").toLowerCase();
  if (t.includes("image")) return "image";
  if (t.includes("video")) return "video";
  if (t.includes("audio") || t.includes("music") || t.includes("sound") || t.includes("voice") || t.includes("speech") || t.includes("tts")) {
    return "audio";
  }
  const path = url.split(/[?#]/)[0]?.toLowerCase() ?? "";
  if (path.includes("/img/")) return "image";
  if (path.includes("/vid/")) return "video";
  if (path.includes("/aud/")) return "audio";
  const ext = path.match(/\.([a-z0-9]+)$/)?.[1];
  if (ext) {
    if (IMAGE_EXTS.has(ext)) return "image";
    if (VIDEO_EXTS.has(ext)) return "video";
    if (AUDIO_EXTS.has(ext)) return "audio";
  }
  return null;
}

/** Build deduped descriptors from output URLs. URLs whose kind can't be resolved are dropped. */
export function buildMediaDescriptors(urls: string[] | undefined, typeHint?: string): MediaDescriptor[] {
  if (!Array.isArray(urls)) return [];
  const seen = new Set<string>();
  const out: MediaDescriptor[] = [];
  for (const url of urls) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const kind = kindOf(url, typeHint);
    if (!kind) continue;
    seen.add(url);
    out.push({ kind, url });
  }
  return out;
}
