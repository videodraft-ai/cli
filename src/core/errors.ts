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
  /** Optional machine-readable server recovery contract. */
  data?: unknown;

  constructor(
    message: string,
    exitCode: number = EXIT.ERROR,
    hint?: string,
    data?: unknown,
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.hint = hint;
    this.data = data;
  }
}

/** Invalid user-supplied flags or arguments. */
export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.USAGE, hint);
    this.name = "UsageError";
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

const CREDIT_ERROR_RE =
  /insufficient credits|not enough credits|credit balance/i;

/** A tools/call result that came back isError:true. */
export class ToolError extends CliError {
  toolName: string;

  constructor(toolName: string, message: string, data?: unknown) {
    const isCredits = CREDIT_ERROR_RE.test(message);
    const realPersonHint = seedanceRealPersonRetryHint(data);
    super(
      message,
      isCredits ? EXIT.CREDITS : EXIT.ERROR,
      isCredits
        ? "Check your balance with `videodraft credits` or top up at https://app.videodraft.ai/pricing"
        : realPersonHint,
      data,
    );
    this.name = "ToolError";
    this.toolName = toolName;
  }
}

export function seedanceRealPersonRetryHint(
  value: unknown,
): string | undefined {
  const payload = value as any;
  if (
    payload?.code !== "SEEDANCE_REAL_PERSON_OPT_IN_REQUIRED" &&
    payload?.retry_with?.allow_real_people !== true
  ) {
    return undefined;
  }
  return "Retry this Seedance request once with --allow-real-people. This uses higher Fal-tier pricing.";
}

/**
 * A hosted retry the route refused BEFORE charging or submitting anything —
 * insufficient credits, provider not configured — does not consume the single
 * real-person retry. Without saying so, a user who sees "failed" assumes their
 * one attempt is gone and stops.
 */
export function seedanceRetryPreservedHint(
  value: unknown,
): string | undefined {
  const segments = (value as any)?.failed_segments;
  if (!Array.isArray(segments)) return undefined;
  if (!segments.some((segment: any) => segment?.retry_preserved === true)) {
    return undefined;
  }
  return "Nothing was charged or submitted for those, so the one real-person retry is still available — fix the reported error and run the same command again.";
}

/**
 * A submission whose response was lost may still be running and billed. The
 * server keeps its claim so a later produce reattaches it, so the one thing
 * the caller must NOT do is resubmit.
 */
export function seedanceUnresolvedSubmissionHint(
  value: unknown,
): string | undefined {
  const segments = (value as any)?.failed_segments;
  if (!Array.isArray(segments)) return undefined;
  if (
    !segments.some((segment: any) => segment?.submission_unresolved === true)
  ) {
    return undefined;
  }
  return "Some submissions were never acknowledged and may still be running. Re-run produce to reattach them before retrying — do not resubmit.";
}

export class TimeoutError extends CliError {
  constructor(message: string) {
    super(message, EXIT.ERROR);
    this.name = "TimeoutError";
  }
}
