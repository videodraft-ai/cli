/**
 * `videodraft skills ...` — install / show the bundled VideoDraft agent skill.
 *
 * The skill (SKILL.md + references/) is BAKED INTO the executable at build time
 * (tsup `define: __SKILL_ASSETS__`, see tsup.config.ts + skill-assets-global.d.ts),
 * mirroring how __CLI_VERSION__ is embedded. That is what lets the compiled
 * single-file binary (bun build --compile) serve and install the skill: there,
 * `import.meta.url` resolves inside an embedded virtual FS, so the old on-disk
 * read failed. In tsx dev / the npm dist we fall back to reading skills/videodraft/
 * next to src/ (or dist/).
 *
 * `install` writes the skill into each agent's skills dir. With no --agent it
 * AUTO-DETECTS installed agents (their ~/.<agent> dir exists), matching the
 * `npx skills` convention. Every supported agent reads
 * `~/.<agent>/skills/<name>/SKILL.md` natively (Codex ships a SkillsWatcher over
 * ~/.codex/skills). Already-present installs are skipped unless --force.
 *   claude  → ~/.claude/skills/videodraft   (or ./.claude/skills with --project)
 *   codex   → ~/.codex/skills/videodraft
 *   cursor  → ~/.cursor/skills/videodraft
 * For a cross-agent multiselect users can also run
 * `npx skills add videodraft-ai/cli` or `gh skill install videodraft-ai/cli`.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { buildContext } from "../cli/context.js";
import { emit, fmt, note } from "../cli/output.js";
import { CliError, EXIT } from "../core/errors.js";
import { capture } from "../cli/telemetry.js";

/** skills/ sits next to dist/ (and next to src/ in dev) at the package root.
 *  Used by `skills path` and as the tsx-dev / npm-dist fallback source. Throws
 *  in the compiled binary (which has no on-disk skills/), where the baked
 *  __SKILL_ASSETS__ is used instead. */
export function bundledSkillDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../skills/videodraft"), // dist/ or src/commands compiled flat
    path.resolve(here, "../../skills/videodraft"), // src/commands in dev (tsx)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) return candidate;
  }
  throw new CliError(
    "Bundled skill not found (package is missing skills/videodraft).",
  );
}

/** The skill as a { relative path → contents } map. Prefers the build-time-baked
 *  blob (works everywhere, including the compiled single-file binary) and falls
 *  back to reading disk in tsx dev / the npm dist. */
export function bundledSkillFiles(): Record<string, string> {
  if (typeof __SKILL_ASSETS__ !== "undefined" && __SKILL_ASSETS__) {
    return JSON.parse(__SKILL_ASSETS__) as Record<string, string>;
  }
  // tsx dev / npm dist: walk the on-disk skill tree (matches tsup's build-time bake).
  const root = bundledSkillDir();
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        files[path.relative(root, full).split(path.sep).join("/")] =
          fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return files;
}

/** Write the skill tree into <destRoot>/{SKILL.md, references/*}. */
function writeSkillFiles(
  files: Record<string, string>,
  destRoot: string,
): void {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

const KNOWN_AGENTS = ["claude", "codex", "cursor"] as const;
type Agent = (typeof KNOWN_AGENTS)[number];

// Accept the ecosystem's agent ids (npx skills uses "claude-code") as aliases.
const AGENT_ALIASES: Record<string, Agent> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  "openai-codex": "codex",
  cursor: "cursor",
};

function agentDir(agent: Agent): string {
  return { claude: ".claude", codex: ".codex", cursor: ".cursor" }[agent];
}

function targetDir(agent: Agent, project: boolean): string {
  const root = project ? process.cwd() : os.homedir();
  return path.join(root, agentDir(agent), "skills", "videodraft");
}

/** Which agents look installed on this machine (their home config dir exists)? */
function detectInstalledAgents(): Agent[] {
  return KNOWN_AGENTS.filter((a) => {
    try {
      return fs.existsSync(path.join(os.homedir(), agentDir(a)));
    } catch {
      return false;
    }
  });
}

interface AgentResolution {
  agents: Agent[];
  source: "all" | "explicit" | "detected" | "default";
}

/**
 * Resolve the install targets, mirroring the `npx skills` convention:
 * --all → every agent; explicit --agent → those; otherwise auto-detect the
 * installed agents; if none are detected, fall back to claude.
 */
function resolveAgents(rawValues: string[], all: boolean): AgentResolution {
  if (all) return { agents: [...KNOWN_AGENTS], source: "all" };

  const requested = rawValues
    .flatMap((v) => v.split(","))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  if (requested.length > 0) {
    const bad = requested.filter((a) => !(a in AGENT_ALIASES));
    if (bad.length > 0) {
      throw new CliError(
        `Unknown agent(s): ${bad.join(", ")}. Use ${KNOWN_AGENTS.join(" | ")} (or --all).`,
        EXIT.USAGE,
      );
    }
    return {
      agents: [...new Set(requested.map((a) => AGENT_ALIASES[a]!))],
      source: "explicit",
    };
  }

  const detected = detectInstalledAgents();
  if (detected.length > 0) return { agents: detected, source: "detected" };
  return { agents: ["claude"], source: "default" };
}

/** Friendly `skills show <section>` name → skill file. */
const SECTION_ALIASES: Record<string, string> = {
  "": "SKILL.md",
  skill: "SKILL.md",
  editor: "references/editor.md",
  examples: "references/examples.md",
  models: "references/models.md",
  pipeline: "references/pipeline.md",
};

export function registerSkillCommands(program: Command): void {
  const skills = program
    .command("skills")
    .description("The VideoDraft agent skill");

  skills
    .command("install")
    .description(
      "Install the VideoDraft skill (auto-detects your installed agents by default)",
    )
    .option(
      "--agent <agents>",
      "claude | codex | cursor — repeatable or comma-separated. Omit to auto-detect installed agents.",
      (v: string, prev: string[] = []) => [...prev, v],
      [] as string[],
    )
    .option(
      "--all",
      "install for every supported agent (claude, codex, cursor)",
    )
    .option(
      "--project",
      "install into the current project (./.claude/skills) instead of globally",
    )
    .option("--force", "overwrite existing installation(s)")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const opts = this.opts<{
        agent: string[];
        all?: boolean;
        project?: boolean;
        force?: boolean;
      }>();
      const files = bundledSkillFiles();
      const { agents, source } = resolveAgents(opts.agent, Boolean(opts.all));

      if (source === "detected") {
        note(
          ctx.out,
          fmt.dim(ctx.out, `Detected installed agent(s): ${agents.join(", ")}`),
        );
      } else if (source === "default") {
        note(
          ctx.out,
          fmt.dim(
            ctx.out,
            "No agents detected — defaulting to claude. Target others with --agent or --all.",
          ),
        );
      }

      const results = agents.map((agent) => {
        const dest = targetDir(agent, Boolean(opts.project));
        const existed = fs.existsSync(dest);
        if (existed && !opts.force) {
          return {
            agent,
            installed_to: dest,
            status: "skipped" as const,
            reason: "already installed (use --force)",
          };
        }
        writeSkillFiles(files, dest);
        return {
          agent,
          installed_to: dest,
          status: existed ? ("overwritten" as const) : ("installed" as const),
        };
      });

      capture("cli_skills_install", {
        agents: agents.join(","),
        count: agents.length,
        source,
        project: Boolean(opts.project),
      });

      const anyInstalled = results.some((r) => r.status !== "skipped");
      emit(ctx.out, { ok: true, results }, (o) => {
        for (const r of results) {
          if (r.status === "skipped") {
            note(o, fmt.yellow(o, `• ${r.agent}: skipped — ${r.reason}`));
          } else {
            note(
              o,
              fmt.green(o, `• ${r.agent}: ${r.status} → ${r.installed_to}`),
            );
          }
        }
        if (!anyInstalled) {
          note(
            o,
            fmt.dim(
              o,
              "Nothing changed. Re-run with --force to overwrite existing installs.",
            ),
          );
        }
        note(o, fmt.dim(o, "Other agents: npx skills add videodraft-ai/cli"));
      });
    });

  skills
    .command("show [section]")
    .description(
      "Print the skill, or a section: skill | editor | examples | models | pipeline",
    )
    .option("--all", "output every skill file as a JSON map (path → contents)")
    .action(async function (this: Command, section: string | undefined) {
      const ctx = buildContext(this);
      const opts = this.opts<{ all?: boolean }>();
      const files = bundledSkillFiles();

      if (opts.all) {
        capture("cli_skills_show", { section: "all" });
        emit(ctx.out, { files }, (o) => {
          for (const [rel, content] of Object.entries(files)) {
            note(o, fmt.dim(o, `\n===== ${rel} =====`));
            process.stdout.write(
              content.endsWith("\n") ? content : `${content}\n`,
            );
          }
        });
        return;
      }

      // Resolve via a friendly alias or a raw own-key of the blob. Object.hasOwn
      // guards against prototype members ("toString", "__proto__", "constructor"),
      // which bracket access would otherwise return as functions and crash below.
      const key = (section ?? "").toLowerCase();
      let rel: string | undefined;
      if (Object.hasOwn(SECTION_ALIASES, key)) rel = SECTION_ALIASES[key];
      else if (section && Object.hasOwn(files, section)) rel = section;
      const content = rel === undefined ? undefined : files[rel];
      if (content === undefined) {
        throw new CliError(
          `Unknown skill section "${section}". Try: skill | editor | examples | models | pipeline (or --all).`,
          EXIT.USAGE,
        );
      }
      capture("cli_skills_show", { section: rel });
      emit(ctx.out, { section: rel, content }, () => {
        process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
      });
    });

  skills
    .command("path")
    .description(
      "Print the bundled skill's on-disk location (npm install; not the compiled binary)",
    )
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const dir = bundledSkillDir();
      emit(ctx.out, { path: dir }, () => {
        process.stdout.write(`${dir}\n`);
      });
    });
}
