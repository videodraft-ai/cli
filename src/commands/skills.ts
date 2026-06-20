/**
 * `videodraft skills ...` — install the bundled VideoDraft agent skill.
 *
 * The skill ships inside the npm package (skills/videodraft/). With no --agent,
 * install AUTO-DETECTS which agents are present on the machine (their ~/.<agent>
 * dir exists) and installs to those — matching the `npx skills` convention.
 * --agent (repeatable / comma-separated) or --all override detection:
 *   claude  → ~/.claude/skills/videodraft        (or .claude/skills with --project)
 *   codex   → ~/.codex/skills/videodraft         (+ pointer hint for AGENTS.md)
 *   cursor  → ~/.cursor/skills/videodraft
 * Already-present installs are skipped (idempotent) unless --force is passed.
 * For the full interactive multiselect across 69+ agents, users can instead run
 * `npx skills add videodraft-ai/cli` (the vercel-labs tool) once the repo is public.
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

/** skills/ sits next to dist/ (and next to src/ in dev) at the package root. */
export function bundledSkillDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../skills/videodraft"), // dist/ or src/commands compiled flat
    path.resolve(here, "../../skills/videodraft"), // src/commands in dev (tsx)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) return candidate;
  }
  throw new CliError("Bundled skill not found (package is missing skills/videodraft).");
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
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
    return { agents: [...new Set(requested.map((a) => AGENT_ALIASES[a]!))], source: "explicit" };
  }

  const detected = detectInstalledAgents();
  if (detected.length > 0) return { agents: detected, source: "detected" };
  return { agents: ["claude"], source: "default" };
}

export function registerSkillCommands(program: Command): void {
  const skills = program.command("skills").description("The VideoDraft agent skill");

  skills
    .command("install")
    .description("Install the VideoDraft skill (auto-detects your installed agents by default)")
    .option(
      "--agent <agents>",
      "claude | codex | cursor — repeatable or comma-separated. Omit to auto-detect installed agents.",
      (v: string, prev: string[] = []) => [...prev, v],
      [] as string[],
    )
    .option("--all", "install for every supported agent (claude, codex, cursor)")
    .option("--project", "install into the current project (./.claude/skills) instead of globally")
    .option("--force", "overwrite existing installation(s)")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const opts = this.opts<{ agent: string[]; all?: boolean; project?: boolean; force?: boolean }>();
      const src = bundledSkillDir();
      const { agents, source } = resolveAgents(opts.agent, Boolean(opts.all));

      if (source === "detected") {
        note(ctx.out, fmt.dim(ctx.out, `Detected installed agent(s): ${agents.join(", ")}`));
      } else if (source === "default") {
        note(
          ctx.out,
          fmt.dim(ctx.out, "No agents detected — defaulting to claude. Target others with --agent or --all."),
        );
      }

      const results = agents.map((agent) => {
        const dest = targetDir(agent, Boolean(opts.project));
        const existed = fs.existsSync(dest);
        if (existed && !opts.force) {
          return { agent, installed_to: dest, status: "skipped" as const, reason: "already installed (use --force)" };
        }
        copyDir(src, dest);
        return { agent, installed_to: dest, status: existed ? ("overwritten" as const) : ("installed" as const) };
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
            note(o, fmt.green(o, `• ${r.agent}: ${r.status} → ${r.installed_to}`));
          }
        }
        if (agents.includes("codex")) {
          note(o, fmt.dim(o, 'Codex leans on AGENTS.md — also add "Use the videodraft skill for video/image generation" there.'));
        }
        if (!anyInstalled) {
          note(o, fmt.dim(o, "Nothing changed. Re-run with --force to overwrite existing installs."));
        }
        note(o, fmt.dim(o, "Other agents: npx skills add videodraft-ai/cli"));
      });
    });

  skills
    .command("path")
    .description("Print the bundled skill's location (for manual installs)")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const dir = bundledSkillDir();
      emit(ctx.out, { path: dir }, () => {
        process.stdout.write(`${dir}\n`);
      });
    });
}
