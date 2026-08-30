#!/usr/bin/env tsx
/**
 * Generate (or --check) skills/index.json — the machine-readable registry that
 * `npx skills add` / `gh skill install` consume for integrity-verified installs.
 * Mirrors fal-ai-community/skills' build-skills-index.py: a deterministic walk
 * with sha256 + byte length per file.
 *
 *   tsx scripts/build-skills-index.ts          # write skills/index.json
 *   tsx scripts/build-skills-index.ts --check   # exit 1 if the file is stale (CI)
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const INDEX_FILE = path.join(SKILLS_DIR, "index.json");

/** Minimal SKILL.md frontmatter reader: `key: value` lines plus folded (`>`) and
 *  literal (`|`) blocks collapsed to a single spaced string. No YAML dep. */
function parseFrontmatter(md: string): Record<string, string> {
  if (!md.startsWith("---\n")) throw new Error("SKILL.md is missing YAML frontmatter");
  const end = md.indexOf("\n---", 4);
  if (end === -1) throw new Error("SKILL.md frontmatter is not closed");
  const lines = md.slice(4, end).split("\n");
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    if (val === ">" || val === ">-" || val === "|" || val === "|-") {
      const block: string[] = [];
      let j = i + 1;
      while (j < lines.length && (/^\s{2,}/.test(lines[j]!) || lines[j]!.trim() === "")) {
        block.push(lines[j]!.trim());
        j++;
      }
      val = block.join(" ").replace(/\s+/g, " ").trim();
      i = j - 1;
    }
    out[key] = val;
  }
  return out;
}

/** All files under a skill dir, relative + POSIX-separated, deterministically sorted. */
function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** Quality lint (mirrors higgsfield's validate-skills): description length,
 *  reference links resolve, no orphaned references, no parent-dir links. */
function validateSkill(name: string, dir: string, skillMd: string, fm: Record<string, string>): void {
  if (fm.description.length > 1024) {
    throw new Error(`skills/${name}: description is ${fm.description.length} chars (> 1024, the Agent Skills limit)`);
  }
  const hasParentLink = (md: string) => /\]\(\.\.\//.test(md);
  if (hasParentLink(skillMd)) {
    throw new Error(`skills/${name}/SKILL.md has a parent-dir (../) link; keep the skill self-contained`);
  }
  const linked = new Set([...skillMd.matchAll(/\]\((references\/[A-Za-z0-9_./-]+\.md)\)/g)].map((m) => m[1]!));
  for (const ref of linked) {
    if (!fs.existsSync(path.join(dir, ref))) {
      throw new Error(`skills/${name}/SKILL.md links ${ref} but that file is missing`);
    }
  }
  const refDir = path.join(dir, "references");
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir)) {
      if (!f.endsWith(".md")) continue;
      const rel = `references/${f}`;
      if (!linked.has(rel)) throw new Error(`skills/${name}: ${rel} is an orphan (not linked from SKILL.md)`);
      if (hasParentLink(fs.readFileSync(path.join(dir, rel), "utf8"))) {
        throw new Error(`skills/${name}/${rel} has a parent-dir (../) link`);
      }
    }
  }
}

function buildIndex() {
  const names = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  const skills = names.map((name) => {
    const dir = path.join(SKILLS_DIR, name);
    const skillMdPath = path.join(dir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) throw new Error(`skills/${name} is missing SKILL.md`);
    const skillMd = fs.readFileSync(skillMdPath, "utf8");
    const fm = parseFrontmatter(skillMd);
    if (!fm.name || !fm.description) throw new Error(`skills/${name}/SKILL.md needs name + description`);
    if (fm.name !== name) throw new Error(`skills/${name}: frontmatter name "${fm.name}" != dir "${name}"`);
    validateSkill(name, dir, skillMd, fm);
    const files = walkFiles(dir).map((rel) => {
      const buf = fs.readFileSync(path.join(dir, rel));
      return { path: rel, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
    });
    return { name: fm.name, description: fm.description, files };
  });
  return { version: 1, skills };
}

const serialized = `${JSON.stringify(buildIndex(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = fs.existsSync(INDEX_FILE) ? fs.readFileSync(INDEX_FILE, "utf8") : "";
  if (current !== serialized) {
    console.error("skills/index.json is stale. Run: tsx scripts/build-skills-index.ts");
    process.exit(1);
  }
  console.log("skills/index.json is up to date.");
} else {
  fs.writeFileSync(INDEX_FILE, serialized);
  const count = JSON.parse(serialized).skills.length;
  console.log(`Wrote ${path.relative(ROOT, INDEX_FILE)} (${count} skill(s)).`);
}
