#!/usr/bin/env tsx
/**
 * Keep every plugin manifest's version in lockstep with package.json — the
 * single source of truth (also baked into the binary as __CLI_VERSION__).
 * Mirrors higgsfield-ai/skills' CI version-sync check.
 *
 *   tsx scripts/check-manifest-versions.ts          # exit 1 on any drift (CI)
 *   tsx scripts/check-manifest-versions.ts --write   # stamp package.json version in
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version: string = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const write = process.argv.includes("--write");

// Each entry: [relative file, accessor into the parsed doc for the version field].
const targets: Array<[string, { get: (d: any) => string; set: (d: any, v: string) => void }]> = [
  [".claude-plugin/plugin.json", { get: (d) => d.version, set: (d, v) => (d.version = v) }],
  [".claude-plugin/marketplace.json", { get: (d) => d.plugins[0].version, set: (d, v) => (d.plugins[0].version = v) }],
  [".codex-plugin/plugin.json", { get: (d) => d.version, set: (d, v) => (d.version = v) }],
  [".cursor-plugin/plugin.json", { get: (d) => d.version, set: (d, v) => (d.version = v) }],
];

let drift = false;
for (const [rel, acc] of targets) {
  const file = path.join(ROOT, rel);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (acc.get(doc) === version) continue;
  if (write) {
    acc.set(doc, version);
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`stamped ${rel} -> ${version}`);
  } else {
    console.error(`${rel}: version ${acc.get(doc)} != package.json ${version}`);
    drift = true;
  }
}

if (drift) {
  console.error("Run: tsx scripts/check-manifest-versions.ts --write");
  process.exit(1);
}
if (!write) console.log(`All plugin manifests at version ${version}.`);
