import { defineConfig } from "tsup";

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
