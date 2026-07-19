import fs from "node:fs";

/**
 * Resolve the CLI version across all three run modes:
 *
 *  1. Built dist / `bun build --compile` single-file binary — the version is
 *     BAKED IN at build time. tsup's esbuild `define` (tsup.config.ts) replaces
 *     the __CLI_VERSION__ token with the JSON-stringified package.json version,
 *     so no filesystem read happens. This is REQUIRED for the compiled binary:
 *     `import.meta.url` there points inside the embedded virtual FS, so the old
 *     `fs.readFileSync(new URL("../package.json", import.meta.url))` threw and
 *     `--version` printed the "0.0.0" fallback.
 *  2. tsx dev (src/) — no define ran, so __CLI_VERSION__ is undefined; fall back
 *     to reading ../package.json relative to this module.
 */
function readVersionFromDisk(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function resolveVersion(): string {
  // __CLI_VERSION__ is a build-time define (see tsup.config.ts + the ambient
  // declaration in cli-version-global.d.ts). Guarded with typeof so the tsx-dev
  // path, where the identifier is never substituted, doesn't ReferenceError.
  if (typeof __CLI_VERSION__ !== "undefined" && __CLI_VERSION__) {
    return __CLI_VERSION__;
  }
  return readVersionFromDisk();
}

export const VERSION: string = resolveVersion();
