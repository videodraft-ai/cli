/**
 * Per-invocation context: resolved auth + client + output + global flags.
 * Built once from commander's merged global options.
 */

import type { Command } from "commander";
import { createHash } from "node:crypto";
import { VideoDraftClient } from "../core/rpc.js";
import { resolveAuth } from "../auth/token-provider.js";
import {
  createConnectionSessionStore,
  type ConnectionSessionStore,
} from "../core/session.js";
import { makeOutput, type OutputContext } from "./output.js";
import { VERSION } from "../version.js";

export interface GlobalFlags {
  json?: boolean;
  color?: boolean;
  baseUrl?: string;
  token?: string;
  profile?: string;
  waitInterval?: string;
  waitTimeout?: string;
}

export interface CommandContext {
  client: VideoDraftClient;
  out: OutputContext;
  flags: GlobalFlags;
  baseUrl: string;
  profileName?: string;
  /** The connection-session store the client replays Mcp-Session-Id from (absent when disabled). */
  session?: ConnectionSessionStore;
  intervalMs: number;
  timeoutMs: number;
  /** Adaptive poll backoff — disabled when the user pinned --wait-interval. */
  adaptive: boolean;
}

/**
 * The session_id to send for a generation. An explicitly passed --session
 * always wins. The VIDEODRAFT_SESSION *default* is dropped when --project is
 * also given, because project generations belong to the project's own session
 * and the server rejects a session that is not that project's. Commander's
 * option source tells the two apart, so --session <x> is honored even when x
 * happens to equal the env value.
 */
export function sessionArg(
  command: Command,
  opts: {
    session?: string;
    project?: string;
  },
): string | undefined {
  if (!opts.session) return undefined;
  if (opts.project) {
    const source = command.getOptionValueSource?.("session");
    if (source === undefined || source === "default") return undefined;
  }
  return opts.session;
}

/**
 * The identity component of the connection-session scope. OAuth profiles use
 * their profile name; a bare --token / VIDEODRAFT_API_KEY has no profile, and
 * mapping every token to one shared "default" scope let two accounts using
 * the same directory evict each other's user-bound session token on every
 * alternation (the server re-mints, replace() overwrites, repeat) —
 * scattering both users' generations across fresh sessions. Fingerprinting
 * the token keeps one scope per authentication identity. The hash is
 * one-way and truncated; the token itself never lands on disk in the scope
 * key.
 */
export function sessionProfileKey(
  profileName: string | undefined,
  explicitToken: string | undefined,
): string {
  if (profileName) return `profile:${profileName}`;
  if (explicitToken) {
    const fp = createHash("sha256")
      .update(explicitToken)
      .digest("hex")
      .slice(0, 16);
    return `token:${fp}`;
  }
  return "default";
}

export function connectionSessionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env.VIDEODRAFT_NO_SESSION?.trim().toLowerCase();
  return !(v === "1" || v === "true" || v === "yes");
}

/** Parse "3s" / "10m" / "500ms" / plain seconds into ms. */
export function parseDuration(
  value: string | undefined,
  fallbackMs: number,
): number {
  if (!value) return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return n * 1_000; // bare number or "s" = seconds
  }
}

export function buildContext(command: Command): CommandContext {
  const flags = command.optsWithGlobals<GlobalFlags>();
  const out = makeOutput({ json: flags.json, color: flags.color });
  const auth = resolveAuth({
    token: flags.token,
    baseUrl: flags.baseUrl,
    profile: flags.profile,
  });
  // Connection session: one Mcp-Session-Id per (profile, base URL, cwd), so
  // project-less generations from this piece of work share one AI Studio
  // session instead of the account-wide "Agent (MCP)" bucket. Disabled with
  // VIDEODRAFT_NO_SESSION=1 (stateless, old behaviour).
  const session = connectionSessionEnabled()
    ? createConnectionSessionStore({
        baseUrl: auth.baseUrl,
        profile: sessionProfileKey(
          auth.profileName,
          flags.token ?? process.env.VIDEODRAFT_API_KEY,
        ),
      })
    : undefined;
  const client = new VideoDraftClient({
    tokenProvider: auth.tokenProvider,
    baseUrl: auth.baseUrl,
    userAgent: `videodraft-cli/${VERSION}`,
    session,
    // Labels the automatic placeholder after the agent host until the agent
    // gives the session a task-specific name.
    clientName: process.env.VIDEODRAFT_CLIENT_NAME,
  });
  return {
    client,
    out,
    flags,
    baseUrl: auth.baseUrl,
    profileName: auth.profileName,
    session,
    intervalMs: parseDuration(flags.waitInterval, 3_000),
    timeoutMs: parseDuration(flags.waitTimeout, 600_000),
    adaptive: flags.waitInterval === undefined,
  };
}

/** Commander collector for repeatable options (--ref a --ref b). */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Drop undefined values so tool args stay clean. */
export function compact<T extends Record<string, unknown>>(
  obj: T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  );
}
