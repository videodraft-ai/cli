/**
 * Error taxonomy + stable exit codes.
 *
 *   0  success
 *   1  generic / server / network error
 *   2  usage error (bad flags/args — commander's default)
 *   3  authentication required or invalid
 *   4  insufficient credits
 *
 * Agents and scripts can branch on these; they are part of the CLI contract
 * and documented in the README.
 */

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  CREDITS: 4,
} as const;

export class CliError extends Error {
  exitCode: number;
  /** One-line remediation shown under the error (human mode only). */
  hint?: string;

  constructor(message: string, exitCode: number = EXIT.ERROR, hint?: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export class AuthError extends CliError {
  constructor(message = "Not authenticated.") {
    super(
      message,
      EXIT.AUTH,
      "Run `videodraft login` (or set VIDEODRAFT_API_KEY to a vd_mcp_... token from /mcp-keys).",
    );
    this.name = "AuthError";
  }
}

/** JSON-RPC layer error (the envelope, not the tool). */
export class RpcError extends CliError {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(`RPC error ${code}: ${message}`);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

const CREDIT_ERROR_RE = /insufficient credits|not enough credits|credit balance/i;

/** A tools/call result that came back isError:true. */
export class ToolError extends CliError {
  toolName: string;

  constructor(toolName: string, message: string) {
    const isCredits = CREDIT_ERROR_RE.test(message);
    super(
      message,
      isCredits ? EXIT.CREDITS : EXIT.ERROR,
      isCredits
        ? "Check your balance with `videodraft credits` or top up at https://app.videodraft.ai/pricing"
        : undefined,
    );
    this.name = "ToolError";
    this.toolName = toolName;
  }
}

export class TimeoutError extends CliError {
  constructor(message: string) {
    super(message, EXIT.ERROR);
    this.name = "TimeoutError";
  }
}
