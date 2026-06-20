/**
 * Generic passthrough — full coverage of every MCP tool, current and future.
 *
 *   videodraft tools list
 *   videodraft tools schema generate_image
 *   videodraft call generate_image --arg prompt="a red fox" --arg num_images=2
 *   videodraft call update_project --args '{"project_id":"...","title":"New"}'
 *
 * --arg values are coerced: valid JSON (numbers, booleans, arrays, objects,
 * quoted strings) parses as JSON; anything else stays a string.
 */

import type { Command } from "commander";
import { buildContext, collect } from "../cli/context.js";
import { emit, fmt, note, table } from "../cli/output.js";
import { CliError, EXIT } from "../core/errors.js";
import { capture } from "../cli/telemetry.js";

export function coerceArgValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

export function parseKeyValueArgs(pairs: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new CliError(`--arg expects key=value, got: ${pair}`, EXIT.USAGE);
    }
    args[pair.slice(0, eq)] = coerceArgValue(pair.slice(eq + 1));
  }
  return args;
}

export function registerToolCommands(program: Command): void {
  const tools = program.command("tools").description("Inspect the full MCP tool catalog");

  tools
    .command("list", { isDefault: true })
    .description("List every available tool")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const list = await ctx.client.listTools();
      emit(ctx.out, list.map((t) => ({ name: t.name, description: t.description })), (o) => {
        table(
          o,
          ["name", "description"],
          list.map((t) => [t.name, t.description.split(/[.!]\s/)[0]!.slice(0, 90)]),
        );
        note(o, fmt.dim(o, `\n${list.length} tools. Inspect one: videodraft tools schema <name>`));
      });
    });

  tools
    .command("schema <name>")
    .description("Show a tool's description and JSON input schema")
    .action(async function (this: Command, name: string) {
      const ctx = buildContext(this);
      const list = await ctx.client.listTools();
      const tool = list.find((t) => t.name === name);
      if (!tool) {
        throw new CliError(
          `Unknown tool: ${name}. List tools with: videodraft tools list`,
          EXIT.USAGE,
        );
      }
      emit(ctx.out, tool);
    });

  program
    .command("call <tool>")
    .description("Call any MCP tool directly (full API coverage)")
    .option("--args <json>", "arguments as a JSON object")
    .option("--arg <key=value>", "single argument (repeatable; values JSON-coerced)", collect, [])
    .option("--stdin", "read the JSON arguments object from stdin")
    .action(async function (this: Command, toolName: string) {
      const ctx = buildContext(this);
      const opts = this.opts<{ args?: string; arg: string[]; stdin?: boolean }>();

      let args: Record<string, unknown> = {};
      if (opts.stdin) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (raw) args = JSON.parse(raw);
      }
      if (opts.args) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(opts.args);
        } catch (err: any) {
          throw new CliError(`--args is not valid JSON: ${err?.message}`, EXIT.USAGE);
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new CliError("--args must be a JSON object", EXIT.USAGE);
        }
        args = { ...args, ...(parsed as Record<string, unknown>) };
      }
      if (opts.arg.length > 0) {
        args = { ...args, ...parseKeyValueArgs(opts.arg) };
      }

      capture("cli_call", { tool: toolName });
      const result = await ctx.client.callTool(toolName, args);
      emit(ctx.out, result);
    });
}
