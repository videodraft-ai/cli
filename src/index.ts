#!/usr/bin/env node
/**
 * videodraft — the official VideoDraft CLI.
 *
 * A thin, agent-friendly client over the VideoDraft MCP endpoint
 * (POST /api/mcp, JSON-RPC 2.0, bearer auth). Curated commands cover the
 * common pipeline; `videodraft call <tool>` reaches every tool.
 */

import { Command, CommanderError } from "commander";
import { CliError, EXIT } from "./core/errors.js";
import { VERSION } from "./version.js";
import { fmt, makeOutput } from "./cli/output.js";
import { buildCommandPath } from "./cli/command-path.js";
import { capture, maybePrintFirstRunNotice, shutdown as telemetryShutdown } from "./cli/telemetry.js";
import { maybeCheckForUpdate } from "./cli/update-check.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerAccountCommands } from "./commands/account.js";
import { registerProjectCommands } from "./commands/projects.js";
import { registerGenerateCommands } from "./commands/generate.js";
import { registerPipelineCommands } from "./commands/pipeline.js";
import { registerJobCommands } from "./commands/jobs.js";
import { registerMediaCommands } from "./commands/media.js";
import { registerToolCommands } from "./commands/tools.js";
import { registerAvatarCommands } from "./commands/avatar.js";
import { registerSkillCommands } from "./commands/skills.js";
import { registerMiscCommands } from "./commands/misc.js";

// HTTPS_PROXY / HTTP_PROXY / NO_PROXY support for corporate networks. The
// undici package ships EnvHttpProxyAgent; setting the global dispatcher makes
// every fetch() in the process honor the proxy env vars.
async function configureProxy(): Promise<void> {
  if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY && !process.env.https_proxy && !process.env.http_proxy) {
    return;
  }
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch {
    // proxy support is best-effort; direct connections still work
  }
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("videodraft")
    .description(
      "Create AI videos, images and audio from your terminal.\n" +
        "Agent-friendly: every command supports --json; exit codes are stable\n" +
        "(0 ok, 1 error, 2 usage, 3 auth, 4 insufficient credits).",
    )
    .version(VERSION, "-v, --version", "print the CLI version")
    .option("--json", "machine-readable JSON output")
    .option("--no-color", "disable colored output (NO_COLOR is also respected)")
    .option("--base-url <url>", "VideoDraft server (default https://app.videodraft.ai; env VIDEODRAFT_BASE_URL)")
    .option("--token <vd_mcp_token>", "bearer token for this invocation (env VIDEODRAFT_API_KEY)")
    .option("--profile <name>", "config profile (default: default)")
    .option("--wait-interval <duration>", "poll interval for --wait, e.g. 3s (default)")
    .option("--wait-timeout <duration>", "max wait for --wait, e.g. 10m (default)")
    .showSuggestionAfterError(true)
    .exitOverride();

  registerAuthCommands(program);
  registerAccountCommands(program);
  registerProjectCommands(program);
  registerPipelineCommands(program);
  registerGenerateCommands(program);
  registerJobCommands(program);
  registerMediaCommands(program);
  registerAvatarCommands(program);
  registerToolCommands(program);
  registerSkillCommands(program);
  registerMiscCommands(program);
  return program;
}

async function main(): Promise<void> {
  await configureProxy();
  maybePrintFirstRunNotice();

  const program = buildProgram();
  const startedAt = Date.now();

  // Telemetry command name comes from the RESOLVED command, set by commander's
  // preAction hook — never parsed from argv (which can't tell an option value
  // like a token from a positional). Stays "help" if parsing fails pre-action.
  let commandPath = "help";
  program.hook("preAction", (_thisCommand, actionCommand) => {
    commandPath = buildCommandPath(actionCommand as unknown as { name(): string; parent?: any });
  });

  try {
    await program.parseAsync(process.argv);
    capture("cli_command", { command: commandPath, ok: true, duration_ms: Date.now() - startedAt });
    await maybeCheckForUpdate();
  } catch (err: any) {
    if (err instanceof CommanderError) {
      // Usage error / help / version. Map exit code; for real errors (non-zero)
      // honor the --json contract with a JSON envelope on stdout (commander has
      // already written a human message to stderr).
      const code = err.exitCode === 0 ? 0 : EXIT.USAGE;
      if (code !== 0) {
        const out = makeOutput({ json: process.argv.includes("--json") });
        if (out.json) {
          process.stdout.write(
            `${JSON.stringify({ error: err.message, exit_code: code, code: err.code }, null, 2)}\n`,
          );
        }
        capture("cli_command", {
          command: commandPath,
          ok: false,
          error_class: "CommanderError",
          duration_ms: Date.now() - startedAt,
        });
      }
      process.exitCode = code;
    } else if (err instanceof CliError) {
      const out = makeOutput({ json: process.argv.includes("--json") });
      if (out.json) {
        process.stdout.write(
          `${JSON.stringify({ error: err.message, exit_code: err.exitCode, hint: err.hint }, null, 2)}\n`,
        );
      } else {
        process.stderr.write(`${fmt.red(out, "Error:")} ${err.message}\n`);
        if (err.hint) process.stderr.write(`${fmt.dim(out, err.hint)}\n`);
      }
      process.exitCode = err.exitCode;
      capture("cli_command", {
        command: commandPath,
        ok: false,
        error_class: err.name,
        duration_ms: Date.now() - startedAt,
      });
    } else {
      const out = makeOutput({ json: process.argv.includes("--json") });
      const message = err?.message ?? String(err);
      if (out.json) {
        process.stdout.write(`${JSON.stringify({ error: message, exit_code: EXIT.ERROR }, null, 2)}\n`);
      } else {
        process.stderr.write(`${fmt.red(out, "Error:")} ${message}\n`);
      }
      process.exitCode = EXIT.ERROR;
      capture("cli_command", {
        command: commandPath,
        ok: false,
        error_class: err?.name ?? "Error",
        duration_ms: Date.now() - startedAt,
      });
    }
  } finally {
    await telemetryShutdown();
  }
}

void main();
