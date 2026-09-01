// Build-time-injected agent skill files, baked by tsup's esbuild `define` (see
// tsup.config.ts) as a JSON string of { "<relative path>": "<contents>" }.
// Mirrors __CLI_VERSION__: present in the built / bun-compiled output, undefined
// in tsx dev (stays an undeclared global → typeof === "undefined"), so
// skills.ts falls back to reading skills/videodraft/ from disk. Declared
// globally so `tsc --noEmit` (tsconfig include: ["src","test"]) typechecks the
// reference.
declare const __SKILL_ASSETS__: string | undefined;
