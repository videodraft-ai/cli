/**
 * Config store: $VIDEODRAFT_CONFIG_DIR || $XDG_CONFIG_HOME/videodraft || ~/.config/videodraft
 *
 * Deliberately NOT ~/.videodraft — the VideoDraft macOS app owns ~/videodraft/
 * (user workspaces) and dot/no-dot adjacency invites confusion.
 *
 * The schema below is a documented contract: the macOS app's sidecar reads the
 * same store to inherit `videodraft login` credentials (the same way it
 * inherits `claude login` / `codex login`). Bump `version` on breaking changes.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export interface Profile {
  base_url: string;
  auth_kind: "pat" | "oauth";
  access_token: string;
  /** OAuth only. */
  refresh_token?: string;
  /** OAuth only — ISO timestamp the access token expires at. */
  expires_at?: string;
  /** OAuth only — the client_id the grant belongs to. */
  client_id?: string;
}

export interface CliConfig {
  version: 1;
  active_profile: string;
  profiles: Record<string, Profile>;
  /** Anonymous machine id for opt-out telemetry. */
  anonymous_id?: string;
  /** Explicit telemetry opt-out persisted via `videodraft config set telemetry false`. */
  telemetry?: boolean;
  /** Epoch ms of the last npm update check. */
  last_update_check?: number;
}

export const DEFAULT_BASE_URL = "https://app.videodraft.ai";

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VIDEODRAFT_CONFIG_DIR) return env.VIDEODRAFT_CONFIG_DIR;
  const xdg = env.XDG_CONFIG_HOME;
  return path.join(xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".config"), "videodraft");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), "config.json");
}

function emptyConfig(): CliConfig {
  return { version: 1, active_profile: "default", profiles: {} };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  try {
    const raw = fs.readFileSync(configPath(env), "utf8");
    const parsed = JSON.parse(raw) as CliConfig;
    if (!parsed || typeof parsed !== "object" || !parsed.profiles) return emptyConfig();
    return parsed;
  } catch {
    return emptyConfig();
  }
}

/** Atomic write (tmp + rename), 0700 dir / 0600 file. */
export function writeConfig(config: CliConfig, env: NodeJS.ProcessEnv = process.env): void {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath(env);
  const tmp = path.join(dir, `.config.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
}

export function updateConfig(
  mutate: (config: CliConfig) => void,
  env: NodeJS.ProcessEnv = process.env,
): CliConfig {
  // Serialize EVERY config write under one lock and RE-READ inside it. Without
  // this, a stale-read write from an unrelated path (the update-check stamping
  // last_update_check, a telemetry-preference change) could rename an old
  // snapshot back over freshly-rotated, single-use OAuth tokens written by a
  // concurrent process — breaking the shared CLI/desktop login.
  return withLockSync(
    "config",
    () => {
      const config = readConfig(env);
      mutate(config);
      writeConfig(config, env);
      return config;
    },
    env,
  );
}

export function getProfile(
  name?: string,
  env: NodeJS.ProcessEnv = process.env,
): { name: string; profile: Profile | undefined; config: CliConfig } {
  const config = readConfig(env);
  const profileName = name ?? config.active_profile ?? "default";
  return { name: profileName, profile: config.profiles[profileName], config };
}

export function anonymousId(env: NodeJS.ProcessEnv = process.env): string {
  const config = readConfig(env);
  if (config.anonymous_id) return config.anonymous_id;
  const id = crypto.randomUUID();
  // Persist is best-effort — a read-only config dir must not make this throw
  // (telemetry's capture() depends on it and runs after successful commands).
  try {
    updateConfig((c) => {
      c.anonymous_id = id;
    }, env);
  } catch {
    // unwritable config — use an ephemeral id for this run
  }
  return id;
}

// ---------------------------------------------------------------------------
// Cross-process file lock (used around OAuth refresh — refresh tokens are
// single-use, so two processes must not both redeem the same one).
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 30_000;

/** Unique per-acquisition owner id, written into the lock file. */
function lockOwnerToken(): string {
  return `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Release a lock ONLY if it still holds our owner token. If we stalled past
 * LOCK_STALE_MS another process may have stolen the lock and re-acquired it;
 * deleting it unconditionally would drop the new owner's lock and let a third
 * process enter the critical section concurrently.
 */
function releaseOwnedLock(lockPath: string, owner: string): void {
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (current && current.owner === owner) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // missing / unreadable / not ours — leave it for its real owner
  }
}

/**
 * Synchronous file lock for config mutations. Kept sync so the many sync
 * callers of updateConfig (telemetry, update-check, login) need no async
 * refactor. The CLI is single-task, so briefly blocking on the rare write
 * contention is fine; it fails open after the deadline rather than hang.
 * Distinct lock file from withLock's "oauth-refresh", so no nesting deadlock.
 */
function withLockSync<T>(
  lockName: string,
  fn: () => T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, `${lockName}.lock`);
  const owner = lockOwnerToken();
  const deadline = Date.now() + 10_000;
  let held = false;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx"); // O_EXCL atomic acquire
      fs.writeSync(fd, JSON.stringify({ owner, pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      held = true;
      break;
    } catch {
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true }); // steal a stale lock (holder crashed)
          continue;
        }
      } catch {
        continue; // lock vanished between attempts — retry
      }
      if (Date.now() > deadline) break; // fail open: write without the lock rather than hang
      const until = Date.now() + 5; // brief spin; the lock is held ~1ms
      while (Date.now() < until) {
        /* wait */
      }
    }
  }
  try {
    return fn();
  } finally {
    if (held) releaseOwnedLock(lockPath, owner);
  }
}

export async function withLock<T>(
  lockName: string,
  fn: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, `${lockName}.lock`);
  const owner = lockOwnerToken();

  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      // O_EXCL create is the atomic acquire.
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({ owner, pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      break;
    } catch {
      // Lock held — steal it if stale (holder crashed), otherwise wait.
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // disappeared between attempts
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock ${lockName} (${lockPath})`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  try {
    return await fn();
  } finally {
    releaseOwnedLock(lockPath, owner);
  }
}
