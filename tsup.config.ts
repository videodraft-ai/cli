import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Read the package version at config-eval (build) time so it can be baked into
// the executable bundle. The compiled single-file binary can't fs-read
// package.json at runtime — it resolves inside the embedded virtual FS — so
// version.ts reads this build-time global instead (see src/version.ts).
const pkgVersion: string = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

export default defineConfig([
  // The executable. src/index.ts carries the #!/usr/bin/env node shebang,
  // which esbuild preserves on the entry output.
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    clean: true,
    sourcemap: false,
    dts: false,
    splitting: false,
    // Bake the version in so version.ts can read it from a build-time global
    // (and only falls back to the package.json read in tsx dev). esbuild
    // `define` does textual substitution, so the value must be a JS source
    // string — hence JSON.stringify.
    define: { __CLI_VERSION__: JSON.stringify(pkgVersion) },
  },
  // The embeddable client (`import { VideoDraftClient } from "videodraft/client"`).
  // Runtime-agnostic: no commander, no prompts, no process.exit.
  {
    entry: { client: "src/client.ts" },
    format: ["esm"],
    target: "node20",
    platform: "neutral",
    clean: false,
    sourcemap: false,
    dts: true,
    splitting: false,
    external: ["node:fs", "node:path", "node:os", "node:crypto", "node:http"],
  },
]);
