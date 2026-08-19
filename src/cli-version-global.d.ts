// Build-time-injected CLI version. tsup's esbuild `define` (see tsup.config.ts)
// textually replaces __CLI_VERSION__ with the JSON-stringified package.json
// version in the built / bun-compiled output. In tsx dev it is never
// substituted (stays an undeclared global → typeof === "undefined"), so
// version.ts falls back to the runtime package.json read. Declared globally so
// `tsc --noEmit` (tsconfig include: ["src","test"]) typechecks the reference.
declare const __CLI_VERSION__: string | undefined;
