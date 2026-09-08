/** 3D files are artifacts, not playable image/video/audio media descriptors. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  downloadUrl,
  extFromUrl,
  writePreview,
  type DownloadedFile,
} from "./download.js";
import { buildMediaDescriptors, type MediaDescriptor } from "./media.js";
import { CliError, EXIT } from "./errors.js";

export interface Model3DArtifact {
  id: string;
  role: string;
  url: string;
  filename: string;
  content_type?: string;
  bytes?: number;
  /** Additional relative paths needed by preserved FBX/external dependencies. */
  aliases?: string[];
}

export interface Model3DDownload {
  downloaded_files: DownloadedFile[];
  package_directory: string;
  manifest_path: string;
  package_warnings: string[];
}

export function isModel3DResult(payload: any): boolean {
  return payload?.type === "model3d";
}

function warningStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (warning): warning is string =>
          typeof warning === "string" && Boolean(warning.trim()),
      )
    : [];
}

/** Include formats omitted by the server even when no download was requested. */
export function model3DWarnings(
  payload: any,
  localWarnings: string[] = [],
): string[] {
  return [
    ...new Set([
      ...warningStrings(payload?.artifact_warnings),
      ...warningStrings(payload?.package_warnings),
      ...localWarnings,
    ]),
  ];
}

export function model3DArtifacts(payload: any): Model3DArtifact[] {
  const artifacts: Model3DArtifact[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(payload?.artifacts)
    ? payload.artifacts
    : []) {
    if (
      !item ||
      typeof item.url !== "string" ||
      !/^https?:\/\//i.test(item.url)
    )
      continue;
    const filename = typeof item.filename === "string" ? item.filename : "";
    const key = `${item.url}\n${filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    artifacts.push({
      id: String(item.id ?? `artifact-${artifacts.length}`),
      role: String(item.role ?? "other"),
      url: item.url,
      filename:
        filename || `artifact-${artifacts.length}.${extFromUrl(item.url)}`,
      ...(typeof item.content_type === "string"
        ? { content_type: item.content_type }
        : {}),
      ...(typeof item.bytes === "number" ? { bytes: item.bytes } : {}),
      ...(Array.isArray(item.aliases)
        ? {
            aliases: item.aliases.filter(
              (alias: unknown): alias is string => typeof alias === "string",
            ),
          }
        : {}),
    });
  }
  // Compatibility with an older status payload that only lists model outputs.
  const urls = Array.isArray(payload?.output_urls)
    ? payload.output_urls
    : payload?.outputs;
  for (const url of Array.isArray(urls) ? urls : []) {
    if (
      typeof url !== "string" ||
      !/^https?:\/\//i.test(url) ||
      artifacts.some((a) => a.url === url)
    )
      continue;
    artifacts.push({
      id: `model-${artifacts.length}`,
      role: "model",
      url,
      filename: `model-${artifacts.length}.${extFromUrl(url)}`,
    });
  }
  if (
    typeof payload?.preview_url === "string" &&
    /^https?:\/\//i.test(payload.preview_url) &&
    !artifacts.some((a) => a.url === payload.preview_url)
  ) {
    artifacts.push({
      id: "preview",
      role: "preview",
      url: payload.preview_url,
      filename: `preview.${extFromUrl(payload.preview_url, "png")}`,
    });
  }
  return artifacts;
}

export function model3DOutputFields(payload: any): {
  output_files: Model3DArtifact[];
  output_media: MediaDescriptor[];
  artifact_warnings: string[];
  package_warnings: string[];
} {
  const artifacts = model3DArtifacts(payload);
  // Texture maps are files. Only the rendered preview belongs in the host's gallery.
  const previews = artifacts.filter((a) => a.role === "preview");
  return {
    output_files: artifacts,
    artifact_warnings: warningStrings(payload?.artifact_warnings),
    package_warnings: model3DWarnings(payload),
    output_media: previews.flatMap((a) =>
      buildMediaDescriptors([a.url], a.content_type),
    ),
  };
}

function safeName(value: string, fallback: string): string {
  const name = value.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/^\.+/, "");
  return name && name !== "." && name !== ".." ? name : fallback;
}

/** Keep provider texture subfolders while refusing paths outside the package. */
function safeRelativeFilename(filename: string, index: number): string {
  return normalizeThreeDArtifactFilename(filename || `artifact-${index}.bin`);
}

function truncateUtf8(value: string, maximum: number): string {
  let result = "";
  let bytes = 0;
  for (const character of Array.from(value)) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result;
}

/** Mirror the server helper so canonical filenames/FBX aliases stay unchanged. */
export function normalizeThreeDArtifactFilename(
  name: string,
  extension?: string,
  suffix = "",
): string {
  const cleaned = name
    .replace(/\\/g, "/")
    .replace(/^[A-Za-z]:\//, "")
    .replace(/^\/+/, "");
  const parts = cleaned
    .split("/")
    .filter((part) => part && part !== "." && part !== "..");
  const safeParts = parts.map((part, index) => {
    const sanitized = part.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_");
    const last = index === parts.length - 1;
    const originalExtension = path.posix.extname(sanitized);
    const keptExtension =
      last && extension
        ? `.${extension.replace(/^\./, "")}`
        : truncateUtf8(originalExtension, 24);
    const keptSuffix = last ? truncateUtf8(suffix, 64) : "";
    const base = originalExtension
      ? sanitized.slice(0, -originalExtension.length)
      : sanitized;
    const stem = truncateUtf8(
      base,
      180 - Buffer.byteLength(keptExtension + keptSuffix),
    );
    return `${stem || "artifact"}${keptSuffix}${keptExtension}`;
  });
  while (safeParts.length > 1 && Buffer.byteLength(safeParts.join("/")) > 700)
    safeParts.shift();
  return safeParts.join("/") || `artifact.${extension || "bin"}`;
}

export function model3DPackageDirectory(
  payload: any,
  target: string | true,
): string {
  const id = safeName(
    String(payload?.asset_id ?? payload?.job_id ?? payload?.id ?? "asset"),
    "asset",
  );
  if (target === true) return path.join("media", "3d", id);
  if (/\{(?:index|ext|name)\}/.test(target)) {
    throw new CliError(
      "3D downloads need a package directory. Use --download './media/3d/{job_id}' (no {index}, {name}, or {ext}).",
      EXIT.USAGE,
    );
  }
  const expanded = target
    .replaceAll("{job_id}", safeName(String(payload?.job_id ?? id), "job"))
    .replaceAll("{asset_id}", id);
  if (/\.(?:glb|gltf|fbx|obj|mtl|stl|usdz|zip|bin)$/i.test(expanded)) {
    throw new CliError(
      "3D downloads contain a model, dependencies, and a manifest. Pass a directory to --download, such as ./media/3d.",
      EXIT.USAGE,
    );
  }
  return /\{(?:job_id|asset_id)\}/.test(target)
    ? expanded
    : path.join(expanded, id);
}

interface LocalArtifact extends Model3DArtifact {
  local_path: string;
  source_filename: string;
  downloaded_bytes: number;
  local_aliases?: string[];
}

function writeDependencyAliases(
  directory: string,
  artifacts: LocalArtifact[],
): { files: DownloadedFile[]; warnings: string[] } {
  const occupied = new Map(
    artifacts.map((artifact) => [
      artifact.local_path.toLowerCase(),
      artifact.url,
    ]),
  );
  occupied.set("manifest.json", "manifest");
  const warnings: string[] = [];
  const files: DownloadedFile[] = [];
  for (const artifact of artifacts) {
    const aliases: string[] = [];
    for (const original of artifact.aliases ?? []) {
      const relative = original.replace(/\\/g, "/");
      const segments = relative.split("/");
      if (
        !relative ||
        path.posix.isAbsolute(relative) ||
        segments.some(
          (segment) =>
            !segment ||
            segment === "." ||
            segment === ".." ||
            /[\x00-\x1f\x7f<>:"|?*]/.test(segment),
        )
      ) {
        warnings.push(
          `${artifact.local_path}: unsafe dependency alias was not saved: ${original}`,
        );
        continue;
      }
      if (relative === artifact.local_path) {
        aliases.push(relative);
        continue;
      }
      const lower = relative.toLowerCase();
      const conflict = Array.from(occupied).some(
        ([name, url]) =>
          (name === lower && url !== artifact.url) ||
          name.startsWith(lower + "/") ||
          lower.startsWith(name + "/"),
      );
      if (conflict) {
        warnings.push(
          `${artifact.local_path}: dependency alias collides with another artifact: ${relative}`,
        );
        continue;
      }
      const dest = path.join(directory, relative);
      // An existing same-URL alias (including case-insensitive filesystems) is safe.
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(
          path.join(directory, artifact.local_path),
          dest,
          fs.constants.COPYFILE_EXCL,
        );
        files.push({
          url: artifact.url,
          path: dest,
          bytes: artifact.downloaded_bytes,
        });
      }
      aliases.push(relative);
      occupied.set(lower, artifact.url);
    }
    if (aliases.length) artifact.local_aliases = aliases;
  }
  return { files, warnings };
}

/** Rewrite text-format dependency links using only the returned artifact manifest. */
function localizeDependencies(
  directory: string,
  artifacts: LocalArtifact[],
): string[] {
  const warnings: string[] = [];
  const matching = (
    source: LocalArtifact,
    reference: string,
  ): LocalArtifact | undefined => {
    let decoded = reference;
    try {
      decoded = decodeURIComponent(reference);
    } catch {
      /* keep original */
    }
    const sourceRelative = path.posix.normalize(
      path.posix.join(
        path.posix.dirname(source.source_filename.replace(/\\/g, "/")),
        decoded.replace(/\\/g, "/"),
      ),
    );
    const absoluteUrl = (() => {
      try {
        return new URL(reference, source.url).href;
      } catch {
        return "";
      }
    })();
    const precise = artifacts.filter(
      (a) =>
        a.url === reference ||
        a.url === absoluteUrl ||
        a.source_filename.replace(/\\/g, "/") === sourceRelative,
    );
    if (precise.length === 1) return precise[0];
    const byFilename = artifacts.filter(
      (a) =>
        path.posix.basename(a.source_filename.replace(/\\/g, "/")) ===
        path.posix.basename(decoded.replace(/\\/g, "/")),
    );
    return byFilename.length === 1 ? byFilename[0] : undefined;
  };
  const rewrite = (
    source: LocalArtifact,
    reference: string,
    encode: boolean,
  ): string => {
    if (/^data:/i.test(reference)) return reference;
    const found = matching(source, reference);
    if (!found) {
      warnings.push(
        `${source.local_path}: dependency could not be matched to a saved artifact: ${reference}`,
      );
      return reference;
    }
    const relative = path.posix.relative(
      path.posix.dirname(source.local_path),
      found.local_path,
    );
    return encode
      ? relative.split("/").map(encodeURIComponent).join("/")
      : relative;
  };
  for (const artifact of artifacts) {
    const filename = path.join(directory, artifact.local_path);
    const ext = path.extname(artifact.local_path).toLowerCase();
    if (ext === ".gltf") {
      try {
        const document = JSON.parse(fs.readFileSync(filename, "utf8"));
        // URI fields in glTF include core buffers/images and extension resources.
        const visit = (value: unknown): void => {
          if (Array.isArray(value)) {
            value.forEach(visit);
            return;
          }
          if (!value || typeof value !== "object") return;
          for (const [key, child] of Object.entries(value)) {
            if (key === "uri" && typeof child === "string")
              (value as Record<string, unknown>)[key] = rewrite(
                artifact,
                child,
                true,
              );
            else visit(child);
          }
        };
        visit(document);
        fs.writeFileSync(filename, JSON.stringify(document, null, 2) + "\n");
      } catch (error) {
        warnings.push(
          `${artifact.local_path}: could not resolve glTF dependencies (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    } else if (ext === ".obj" || ext === ".mtl") {
      const contents = fs.readFileSync(filename, "utf8");
      const updated = contents.replace(
        /^(\s*(?:mtllib|map_[a-z0-9_]+|bump|disp|decal|norm|refl)\s+)(.+)$/gim,
        (line, prefix: string, raw: string) => {
          const reference = raw.trim();
          if (reference.startsWith("-")) {
            // MTL options precede the filename; match an unambiguous suffix.
            const candidates = artifacts.filter(
              (a) =>
                reference.endsWith(a.url) ||
                reference.endsWith(a.source_filename) ||
                reference.endsWith(path.posix.basename(a.source_filename)),
            );
            if (candidates.length === 1) {
              const candidate = candidates[0]!;
              const name = reference.endsWith(candidate.url)
                ? candidate.url
                : reference.endsWith(candidate.source_filename)
                  ? candidate.source_filename
                  : path.posix.basename(candidate.source_filename);
              return (
                prefix +
                reference.slice(0, -name.length) +
                rewrite(artifact, name, false)
              );
            }
            warnings.push(
              `${artifact.local_path}: could not resolve material reference: ${reference}`,
            );
            return line;
          }
          if (/mtllib/i.test(prefix) && !matching(artifact, reference)) {
            const references = [...reference.matchAll(/"([^"]+)"|(\S+)/g)].map(
              (match) => match[1] ?? match[2]!,
            );
            if (
              references.length > 1 &&
              references.every((ref) => matching(artifact, ref))
            ) {
              return references
                .map((ref) => prefix + rewrite(artifact, ref, false))
                .join("\n");
            }
          }
          return prefix + rewrite(artifact, reference, false);
        },
      );
      fs.writeFileSync(filename, updated);
    }
    artifact.downloaded_bytes = fs.statSync(filename).size;
  }
  return [...new Set(warnings)];
}

export async function downloadModel3DPackage(
  payload: any,
  target: string | true,
  fetchImpl: typeof fetch = fetch,
): Promise<Model3DDownload> {
  try {
    return await downloadPackage(payload, target, fetchImpl);
  } catch (error) {
    const id = payload?.asset_id ?? payload?.job_id ?? payload?.id;
    throw new CliError(
      error instanceof Error ? error.message : String(error),
      error instanceof CliError ? error.exitCode : EXIT.ERROR,
      id
        ? `The saved 3D asset remains available. Retry downloading with: videodraft assets 3d get ${id} --download`
        : undefined,
      {
        asset_id: payload?.asset_id,
        job_id: payload?.job_id,
        request_id: payload?.request_id,
      },
    );
  }
}

async function downloadPackage(
  payload: any,
  target: string | true,
  fetchImpl: typeof fetch,
): Promise<Model3DDownload> {
  const artifacts = model3DArtifacts(payload);
  if (artifacts.length === 0)
    throw new CliError("The 3D asset has no downloadable artifacts yet.");
  const preferredDirectory = model3DPackageDirectory(payload, target);
  fs.mkdirSync(path.dirname(preferredDirectory), { recursive: true });
  let directory = preferredDirectory;
  for (let suffix = 2; ; suffix++) {
    try {
      fs.mkdirSync(directory);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      directory = `${preferredDirectory}-${suffix}`;
    }
  }
  // Names are chosen before downloading, so dependency mapping is deterministic.
  const used = new Set(["manifest.json"]);
  const local: LocalArtifact[] = artifacts.map((artifact, index) => {
    const original = safeRelativeFilename(artifact.filename, index);
    let relative = original;
    let suffix = 1;
    while (
      Array.from(used).some(
        (name) =>
          name === relative.toLowerCase() ||
          name.startsWith(relative.toLowerCase() + "/") ||
          relative.toLowerCase().startsWith(name + "/"),
      )
    ) {
      // A parent path may already be a file. Fall back to a unique flat name.
      relative = normalizeThreeDArtifactFilename(
        path.posix.basename(original),
        undefined,
        `-${suffix++}`,
      );
    }
    used.add(relative.toLowerCase());
    return {
      ...artifact,
      local_path: relative,
      source_filename: artifact.filename,
      downloaded_bytes: 0,
    };
  });
  const files: DownloadedFile[] = [];
  for (const artifact of local) {
    const dest = path.join(directory, artifact.local_path);
    const temporary = `${dest}.partial-${randomUUID()}`;
    try {
      const file = await downloadUrl(artifact.url, temporary, fetchImpl);
      fs.renameSync(temporary, dest);
      artifact.downloaded_bytes = file.bytes;
      files.push({ ...file, path: dest });
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  const warnings = localizeDependencies(directory, local);
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    file.bytes = local[index]!.downloaded_bytes;
    if (local[index]!.role === "preview") {
      const preview = await writePreview(
        file.path,
        file.url,
        file.bytes,
        fetchImpl,
      );
      if (preview) file.preview = preview;
    }
  }
  const aliases = writeDependencyAliases(directory, local);
  files.push(...aliases.files);
  warnings.push(...aliases.warnings);
  const manifestPath = path.join(directory, "manifest.json");
  const temporaryManifest = `${manifestPath}.partial-${randomUUID()}`;
  const manifest = {
    version: 1,
    type: "model3d",
    asset_id: payload?.asset_id ?? payload?.id,
    job_id: payload?.job_id,
    model: payload?.model,
    credits: payload?.credits,
    byok: payload?.byok,
    complete: warnings.length === 0,
    complete_scope: "returned_artifacts",
    artifact_warnings: warningStrings(payload?.artifact_warnings),
    warnings: model3DWarnings(payload, warnings),
    artifacts: local,
  };
  fs.writeFileSync(temporaryManifest, JSON.stringify(manifest, null, 2) + "\n");
  fs.renameSync(temporaryManifest, manifestPath);
  return {
    downloaded_files: files,
    package_directory: directory,
    manifest_path: manifestPath,
    package_warnings: model3DWarnings(payload, warnings),
  };
}
