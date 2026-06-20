/**
 * Per-invocation context: resolved auth + client + output + global flags.
 * Built once from commander's merged global options.
 */

import type { Command } from "commander";
import { VideoDraftClient } from "../core/rpc.js";
import { resolveAuth } from "../auth/token-provider.js";
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
  intervalMs: number;
  timeoutMs: number;
  /** Adaptive poll backoff — disabled when the user pinned --wait-interval. */
  adaptive: boolean;
}

/** Parse "3s" / "10m" / "500ms" / plain seconds into ms. */
export function parseDuration(value: string | undefined, fallbackMs: number): number {
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
  const client = new VideoDraftClient({
    tokenProvider: auth.tokenProvider,
    baseUrl: auth.baseUrl,
    userAgent: `videodraft-cli/${VERSION}`,
  });
  return {
    client,
    out,
    flags,
    baseUrl: auth.baseUrl,
    profileName: auth.profileName,
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
export function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
