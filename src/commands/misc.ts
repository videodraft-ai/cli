/**
 * `videodraft config | completion | docs`
 */

import type { Command } from "commander";
import { spawn } from "node:child_process";
import { buildContext } from "../cli/context.js";
import { emit, note } from "../cli/output.js";
import { configPath, readConfig, updateConfig } from "../core/config.js";
import { setTelemetryPreference } from "../cli/telemetry.js";
import { CliError, EXIT } from "../core/errors.js";

const DOCS_URL = "https://videodraft.ai/cli";

export function registerMiscCommands(program: Command): void {
  const config = program.command("config").description("CLI configuration");

  config
    .command("path")
    .description("Print the config file location")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      emit(ctx.out, { path: configPath() }, () => process.stdout.write(`${configPath()}\n`));
    });

  config
    .command("get [key]")
    .description("Show config (tokens redacted)")
    .action(async function (this: Command, key?: string) {
      const ctx = buildContext(this);
      const raw = readConfig();
      const redacted = {
        ...raw,
        profiles: Object.fromEntries(
          Object.entries(raw.profiles).map(([name, p]) => [
            name,
            {
              ...p,
              access_token: p.access_token ? `${p.access_token.slice(0, 13)}…` : undefined,
              refresh_token: p.refresh_token ? "vd_rt_…" : undefined,
            },
          ]),
        ),
      };
      const value = key ? (redacted as any)[key] : redacted;
      emit(ctx.out, value ?? null);
    });

  config
    .command("set <key> <value>")
    .description("Set a config value (supported keys: telemetry, base_url)")
    .action(async function (this: Command, key: string, value: string) {
      const ctx = buildContext(this);
      if (key === "telemetry") {
        setTelemetryPreference(!["0", "false", "off"].includes(value.toLowerCase()));
      } else if (key === "base_url") {
        updateConfig((c) => {
          const profile = c.profiles[c.active_profile ?? "default"];
          if (!profile) throw new CliError("No profile yet — run `videodraft login` first.", EXIT.USAGE);
          profile.base_url = value.replace(/\/$/, "");
        });
      } else {
        throw new CliError(`Unsupported key "${key}". Supported: telemetry, base_url.`, EXIT.USAGE);
      }
      emit(ctx.out, { ok: true, [key]: value }, (o) => note(o, "Saved."));
    });

  program
    .command("completion <shell>")
    .description("Print shell completions (bash | zsh)")
    .action(async function (this: Command, shell: string) {
      const root = this.parent!;
      const names = root.commands.map((c) => c.name()).sort();
      if (shell === "bash") {
        process.stdout.write(
          `_videodraft_completions() {\n` +
            `  local cur="\${COMP_WORDS[COMP_CWORD]}"\n` +
            `  if [ "$COMP_CWORD" -eq 1 ]; then\n` +
            `    COMPREPLY=( $(compgen -W "${names.join(" ")}" -- "$cur") )\n` +
            `  fi\n}\n` +
            `complete -F _videodraft_completions videodraft\n`,
        );
      } else if (shell === "zsh") {
        process.stdout.write(
          `#compdef videodraft\n` +
            `_videodraft() {\n  local -a commands\n  commands=(${names.map((n) => `"${n}"`).join(" ")})\n` +
            `  if (( CURRENT == 2 )); then\n    _describe 'command' commands\n  fi\n}\n_videodraft\n`,
        );
      } else {
        throw new CliError(`Unsupported shell "${shell}". Use bash or zsh.`, EXIT.USAGE);
      }
    });

  program
    .command("version")
    .description("Print the CLI version")
    .action(async function (this: Command) {
      const { VERSION } = await import("../version.js");
      process.stdout.write(`${VERSION}\n`);
    });

  program
    .command("docs")
    .description("Open the CLI documentation")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      try {
        const child = spawn(cmd, [DOCS_URL], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
        child.on("error", () => {}); // headless: no opener — URL is printed below
        child.unref();
      } catch {
        // printed below
      }
      emit(ctx.out, { url: DOCS_URL }, () => process.stdout.write(`${DOCS_URL}\n`));
    });
}
