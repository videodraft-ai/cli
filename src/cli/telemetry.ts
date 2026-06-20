/**
 * Anonymous, opt-out usage telemetry.
 *
 * What is sent: command path (e.g. "generate image" — never arguments or
 * prompts), CLI version, OS, Node major, duration, ok/error class. Nothing
 * else. Disclosed in the README and on first run.
 *
 * Opt out with ANY of:
 *   - VIDEODRAFT_TELEMETRY=0 (or "false")
 *   - DO_NOT_TRACK=1            (https://consoledonottrack.com)
 *   - videodraft config set telemetry false
 *
 * Events go to the VideoDraft PostHog project via the public capture API —
 * no SDK dependency. When no key is baked in (local/dev builds), this is a
 * no-op. Sentry crash reporting is intentionally deferred until a CLI Sentry
 * project + DSN exist.
 */

import { readConfig, anonymousId, updateConfig } from "../core/config.js";
import { VERSION } from "../version.js";

// Injected at release time (tsup --env / sed in the release workflow). Public
// write-only key — safe to embed, like any browser PostHog key.
const POSTHOG_KEY = process.env.VIDEODRAFT_POSTHOG_KEY ?? "";
const POSTHOG_HOST = process.env.VIDEODRAFT_POSTHOG_HOST ?? "https://us.i.posthog.com";

let pending: Promise<unknown> | null = null;

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!POSTHOG_KEY) return false;
  if (env.DO_NOT_TRACK && env.DO_NOT_TRACK !== "0") return false;
  const flag = env.VIDEODRAFT_TELEMETRY;
  if (flag && ["0", "false", "off"].includes(flag.toLowerCase())) return false;
  const config = readConfig(env);
  if (config.telemetry === false) return false;
  return true;
}

/** One-time disclosure, printed to stderr on the first tracked invocation. */
export function maybePrintFirstRunNotice(env: NodeJS.ProcessEnv = process.env): void {
  if (!telemetryEnabled(env)) return;
  const config = readConfig(env);
  if (config.anonymous_id) return; // already initialized → already disclosed
  process.stderr.write(
    "videodraft collects anonymous usage data (command name, version, OS — never prompts or content).\n" +
      "Disable anytime: videodraft config set telemetry false  (or DO_NOT_TRACK=1)\n\n",
  );
}

export function capture(event: string, properties: Record<string, unknown> = {}): void {
  // Telemetry must NEVER turn a successful command into a failure. anonymousId()
  // writes to the config store (which can throw on a read-only home/config dir),
  // and main() calls capture() after a command succeeds — so swallow everything,
  // not just the network send.
  try {
    if (!telemetryEnabled()) return;
    const body = JSON.stringify({
      api_key: POSTHOG_KEY,
      event,
      distinct_id: anonymousId(),
      properties: {
      cli_version: VERSION,
      os: process.platform,
      arch: process.arch,
      node_major: Number(process.versions.node.split(".")[0]),
      is_ci: Boolean(process.env.CI),
      ...properties,
    },
  });
    pending = fetch(`${POSTHOG_HOST}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(1_500),
    }).catch(() => undefined);
  } catch {
    // telemetry is best-effort — never propagate
  }
}

/** Give the in-flight capture a short window to land; never block exit long. */
export async function shutdown(): Promise<void> {
  if (!pending) return;
  await Promise.race([pending, new Promise((r) => setTimeout(r, 400))]);
}

export function setTelemetryPreference(enabled: boolean): void {
  updateConfig((c) => {
    c.telemetry = enabled;
  });
}
