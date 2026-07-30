import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// Read the package version at config-eval (build) time so it can be baked into
// the executable bundle. The compiled single-file binary can't fs-read
// package.json at runtime — it resolves inside the embedded virtual FS — so
// version.ts reads this build-time global instead (see src/version.ts).
const pkgVersion: string = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

// Same rationale for the agent skill: bake the whole skill tree (SKILL.md +
// references/*) into the executable as one JSON blob so the compiled binary
// (bun build --compile) can serve/install it without an import.meta.url-relative
// fs read (which fails in the embedded virtual FS). skills.ts reads
// __SKILL_ASSETS__ and falls back to reading disk in tsx dev. The tree is walked
// dynamically — adding a reference file needs no change here or in skills.ts.
const skillRoot = fileURLToPath(new URL("./skills/videodraft", import.meta.url));
function readSkillTree(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // skip .DS_Store and friends
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) readSkillTree(full, out);
    else out[path.relative(skillRoot, full).split(path.sep).join("/")] = readFileSync(full, "utf8");
  }
  return out;
}
const skillAssets = readSkillTree(skillRoot);

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
    // Bake build-time constants in so the runtime (including the bun-compiled
    // single-file binary) needs no disk reads. esbuild `define` does textual
    // substitution, so each value must be a JS source string — hence
    // JSON.stringify. For the skill blob the outer JSON.stringify produces the
    // source-string literal; the inner one is the JSON that skills.ts parses.
    define: {
      __CLI_VERSION__: JSON.stringify(pkgVersion),
      __SKILL_ASSETS__: JSON.stringify(JSON.stringify(skillAssets)),
    },
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
