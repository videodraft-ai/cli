/**
 * Build a telemetry-safe command path from a RESOLVED commander command.
 *
 * Deriving the command name from raw argv is unsafe: an option value like the
 * token in `videodraft --token vd_mcp_… whoami` is indistinguishable from a
 * positional by a naive flag filter and would be recorded. Commander's parsed
 * command tree only ever contains registered command names, so walking it can
 * never leak a user value (prompt, id, token, path).
 */

export interface NamedCommand {
  name(): string;
  parent?: NamedCommand | null;
}

/** "generate video", "skills install", "whoami" — never an argument value. */
export function buildCommandPath(cmd: NamedCommand | null | undefined): string {
  const parts: string[] = [];
  let c: NamedCommand | null | undefined = cmd;
  // Stop before the root program (it has no parent), so we never include argv[1].
  while (c && c.parent) {
    parts.unshift(c.name());
    c = c.parent;
  }
  return parts.join(" ") || "help";
}
