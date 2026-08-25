/**
 * Connection sessions for the CLI.
 *
 * The VideoDraft MCP server hands every connection an `Mcp-Session-Id` on
 * `initialize` and files that connection's project-less generations into its
 * own AI Studio session (initially labelled after the client and date). MCP
 * hosts echo the header for free; the CLI is stateless per invocation, so it
 * keeps the header in a small store and replays it on every request.
 *
 * Scope: one session per (profile, base URL, working directory), expiring
 * after SESSION_IDLE_MS without use. A working directory is a good proxy for
 * "one piece of work" — an agent's workspace, a project folder — and it is
 * stable across the many short-lived shells agents spawn (parent PIDs are
 * not). Override the scope with VIDEODRAFT_SESSION_SCOPE=<any label>, pin an
 * explicit AI Studio session with --session / VIDEODRAFT_SESSION, or rotate
 * with `videodraft sessions reset`.
 *
 * Runtime-agnostic: no console, no process.exit. Fails soft — a broken store
 * just means the server falls back to the shared "Agent (MCP)" session.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { configDir } from "./config.js";

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const MCP_SESSION_HEADER = "Mcp-Session-Id";

export interface ConnectionSessionRecord {
  token: string;
  scope: string;
  cwd: string;
  baseUrl: string;
  profile: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface ConnectionSessionStore {
  /** Current token for this scope, or null when absent/expired. */
  load(): string | null;
  /**
   * Persist a freshly minted token for this scope and return the token that
   * now owns the scope. Two processes racing on an empty scope both mint;
   * the first writer wins and the second gets the winner's token back, so
   * one directory never ends up split across two sessions. Returns null
   * when the token could NOT be persisted (read-only config dir): the
   * caller must then go stateless — sending an unpersisted token would
   * create a fresh AI Studio session per invocation, when the documented
   * degraded mode is the shared server-side fallback.
   */
  save(token: string): string | null;
  /** Replace the scope's token unconditionally (server re-mint). */
  replace(token: string): void;
  /**
   * Forget the current token; the next call re-initialises. Returns whether
   * the deletion actually ran — false means the scope lock could not be
   * taken (or the filesystem refused) and the record may still exist.
   */
  reset(): boolean;
  /** Where this scope's record lives (for `sessions current`). */
  describe(): {
    scope: string;
    file: string;
    record: ConnectionSessionRecord | null;
    /** True when a record exists but is past the idle window. */
    expired: boolean;
    /** The AI Studio session id inside the token, when it parses. */
    sessionId: string | null;
  };
}

export interface SessionScopeInput {
  baseUrl: string;
  profile: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

function sessionsDir(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), "sessions");
}

/** One physical directory → one key, whatever spelling reached us. */
function canonicalCwd(cwd: string): string {
  let out = path.resolve(cwd);
  try {
    out = fs.realpathSync.native(out);
  } catch {
    // unreadable / missing → keep the resolved form
  }
  if (process.platform === "win32") out = out.toLowerCase();
  return out;
}

function canonicalBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").toLowerCase();
}

/** Stable label for this scope; what the record is keyed by. */
export function sessionScope(input: SessionScopeInput): string {
  const env = input.env ?? process.env;
  const explicit = env.VIDEODRAFT_SESSION_SCOPE?.trim();
  const cwd = canonicalCwd(input.cwd ?? process.cwd());
  return explicit && explicit !== "" ? `label:${explicit}` : `cwd:${cwd}`;
}

/** The ai_studio_sessions id carried by a v1 connection token, if any. */
export function sessionIdFromToken(
  token: string | null | undefined,
): string | null {
  if (!token) return null;
  const parts = token.split(".");
  const uuid = parts[1];
  if (parts.length !== 4 || parts[0] !== "v1" || !uuid) return null;
  return /^[0-9a-f-]{36}$/i.test(uuid) ? uuid.toLowerCase() : null;
}

function scopeFile(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  profile: string,
  scope: string,
): string {
  const key = createHash("sha256")
    .update(`${canonicalBaseUrl(baseUrl)}\n${profile}\n${scope}`)
    .digest("hex")
    .slice(0, 24);
  return path.join(sessionsDir(env), `${key}.json`);
}

function readRecord(file: string): ConnectionSessionRecord | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.token === "string" &&
      typeof parsed.lastUsedAt === "string" &&
      typeof parsed.createdAt === "string"
    ) {
      return parsed as ConnectionSessionRecord;
    }
  } catch {
    // missing or corrupt → treat as absent
  }
  return null;
}

function writeRecord(file: string, record: ConnectionSessionRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function isLive(record: ConnectionSessionRecord, nowMs: number): boolean {
  const idle = nowMs - Date.parse(record.lastUsedAt);
  return Number.isFinite(idle) && idle <= SESSION_IDLE_MS;
}

/** How long a reclaim lock may exist before it is considered abandoned. */
const RECLAIM_LOCK_STALE_MS = 2_000;
/** Extra margin past the stale window when waiting to take the lock. */
const RECLAIM_WAIT_MS = 250;
const RECLAIM_POLL_MS = 10;

/** Synchronous sleep without spinning (Atomics.wait needs a shared buffer). */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable → degrade to no wait
  }
}

/**
 * Take the per-scope reclaim lock (O_EXCL). A lock left behind by a crashed
 * process is broken once it is older than RECLAIM_LOCK_STALE_MS — but the
 * break itself must be atomic: an unconditional rm + create lets two
 * processes that both saw the SAME stale lock each delete the other's fresh
 * lock and both believe they hold it. rename() is the atomic claim: only one
 * process can rename a given file away, the loser gets ENOENT, and the
 * winner is the only one that then attempts the exclusive create.
 */
function acquireReclaimLock(file: string): string | null {
  const lock = `${file}.lock`;
  // Unique per ACQUISITION, not per process: release verifies the lock file
  // still carries this exact token before removing it. Without that, a
  // holder paused past the stale window whose lock was broken would, on
  // resume, delete the NEW owner's lock and let a third process in.
  const owner = `${process.pid}:${randomBytes(6).toString("hex")}`;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lock, owner, { mode: 0o600, flag: "wx" });
    return owner;
  } catch (err: any) {
    // Anything but "already locked" (read-only dir, ENOTDIR, …) will not
    // resolve by waiting: throw so callers can go stateless immediately.
    if (err?.code !== "EEXIST") throw err;
    try {
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age <= RECLAIM_LOCK_STALE_MS) return null;
      // Atomically claim the right to break THIS stale lock.
      const claimed = `${lock}.break.${process.pid}`;
      fs.renameSync(lock, claimed);
      fs.rmSync(claimed, { force: true });
      fs.writeFileSync(lock, owner, { mode: 0o600, flag: "wx" });
      return owner;
    } catch {
      // lost the rename (ENOENT) or someone re-locked first
      return null;
    }
  }
}

/** Remove the lock only if this acquisition still owns it. */
function releaseReclaimLock(file: string, owner: string): void {
  const lock = `${file}.lock`;
  try {
    if (fs.readFileSync(lock, "utf8") !== owner) return; // broken + re-owned
    fs.rmSync(lock, { force: true });
  } catch {
    // already gone
  }
}

/**
 * Run a store mutation under the per-scope lock — NEVER without it. EVERY
 * writer goes through this (or holds the lock explicitly, as load()'s touch
 * does): a mutation that wrote unlocked could land between another writer's
 * re-read and write and be undone by the stale copy. Acquisition is
 * effectively guaranteed: live holders release in microseconds, and
 * acquireReclaimLock atomically breaks any lock older than
 * RECLAIM_LOCK_STALE_MS, so the wait is bounded by the stale window plus a
 * margin. If the lock still cannot be taken (pathological filesystem), the
 * mutation is DECLINED — returns false, fn does not run — rather than
 * executed unlocked while a holder may be mid-write. The callback reports
 * whether it actually mutated (a fencing skip returns false), and that
 * outcome is what this function returns — success is never assumed from
 * merely having run.
 */
function withScopeLock(
  file: string,
  fn: (stillOwner: () => boolean) => boolean,
): boolean {
  const deadline = Date.now() + RECLAIM_LOCK_STALE_MS + RECLAIM_WAIT_MS;
  let owner: string | null;
  try {
    owner = acquireReclaimLock(file);
    while (!owner && Date.now() < deadline) {
      sleepSync(RECLAIM_POLL_MS);
      owner = acquireReclaimLock(file);
    }
  } catch {
    return false; // filesystem refuses locks → decline, caller goes stateless
  }
  if (!owner) return false;
  // Fencing guard for the pathological holder: a process suspended past the
  // stale window loses its lock to a takeover; re-checking ownership
  // IMMEDIATELY before each mutation shrinks its overwrite window from
  // seconds to the microseconds between this read and the rename. (Full
  // fencing needs held-fd locks — flock — which plain fs cannot express.)
  const lockPath = `${file}.lock`;
  const stillOwner = () => {
    try {
      return fs.readFileSync(lockPath, "utf8") === owner;
    } catch {
      return false;
    }
  };
  try {
    return fn(stillOwner);
  } finally {
    releaseReclaimLock(file, owner);
  }
}

/** Internal lock primitives, exported for tests only. */
export const __lockInternals = {
  acquireReclaimLock,
  releaseReclaimLock,
  withScopeLock,
};

export function createConnectionSessionStore(
  input: SessionScopeInput,
): ConnectionSessionStore {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now;
  const cwd = input.cwd ?? process.cwd();
  const scope = sessionScope({ ...input, env, cwd });
  const file = scopeFile(env, input.baseUrl, input.profile, scope);

  const fresh = (token: string): ConnectionSessionRecord => {
    const at = new Date(now()).toISOString();
    return {
      token,
      scope,
      cwd,
      baseUrl: input.baseUrl,
      profile: input.profile,
      createdAt: at,
      lastUsedAt: at,
    };
  };

  return {
    load() {
      const record = readRecord(file);
      if (!record || !isLive(record, now())) return null;
      // Touch under a QUICK lock attempt: keeps an active piece of work on
      // one session across days instead of rotating at a fixed age. What is
      // returned is the state OBSERVED UNDER THE LOCK — a concurrent
      // replace/reset landing after the first read must win, or this
      // invocation would file work into the pre-remint (or reset) session
      // while later invocations use the new one. Contended → return null
      // (see below); filesystem refuses locks → the record is provably
      // stable, reuse it.
      const quickDeadline = Date.now() + 5 * RECLAIM_POLL_MS;
      let owner: string | null;
      try {
        owner = acquireReclaimLock(file);
        while (!owner && Date.now() < quickDeadline) {
          sleepSync(RECLAIM_POLL_MS);
          owner = acquireReclaimLock(file);
        }
      } catch {
        // The filesystem refuses lock creation (read-only mount with a
        // previously populated config). No process can be mid-mutation on a
        // filesystem where locks cannot be created, so the readable record
        // is stable — reuse its token rather than failing the command or
        // needlessly going stateless.
        return record.token;
      }
      if (owner) {
        try {
          const current = readRecord(file);
          if (!current || !isLive(current, now())) return null;
          try {
            const lockPath = `${file}.lock`;
            if (fs.readFileSync(lockPath, "utf8") === owner) {
              writeRecord(file, {
                ...current,
                lastUsedAt: new Date(now()).toISOString(),
              });
            }
          } catch {
            // read-only config dir → the token is still usable
          }
          return current.token;
        } finally {
          releaseReclaimLock(file, owner);
        }
      }
      // Contended: a writer is mid-mutation right now. Do not race it with
      // an unlocked snapshot (it may be about to replace or delete this
      // record) — report no session; the handshake re-initialises and
      // save() adopts whatever the writer installed, converging on its
      // outcome.
      return null;
    },
    save(token) {
      // The ENTIRE save — including the first-time empty-scope claim — runs
      // under the per-scope lock, so it serializes against competing saves
      // AND against a concurrent reset/replace: a reset holding the lock
      // finishes first, and this save then installs a fresh record after it
      // (never the reverse, which would hand out a token the reset was
      // about to delete). Under the lock: a live record wins (adopt it, so
      // racing processes converge on one token); anything else is replaced.
      try {
        let result: string | null = null;
        const ran = withScopeLock(file, (stillOwner) => {
          const current = readRecord(file);
          if (current && isLive(current, now())) {
            result = current.token;
            return true;
          }
          if (!stillOwner()) return false; // fenced out mid-mutation
          writeRecord(file, fresh(token));
          result = token;
          return true;
        });
        return ran ? result : null;
      } catch {
        // Could not persist (read-only config dir, etc.). Do NOT hand back
        // the unpersisted token: every short-lived invocation would mint a
        // fresh one and create a session per command. Stateless → the
        // server's shared fallback groups them instead.
        return null;
      }
    },
    replace(token) {
      try {
        withScopeLock(file, (stillOwner) => {
          if (!stillOwner()) return false;
          writeRecord(file, fresh(token));
          return true;
        });
      } catch {
        // fail soft
      }
    },
    reset() {
      try {
        return withScopeLock(file, (stillOwner) => {
          if (!stillOwner()) return false; // fenced out → record may remain
          fs.rmSync(file, { force: true });
          return true;
        });
      } catch {
        return false; // nothing removable
      }
    },
    describe() {
      const record = readRecord(file);
      return {
        scope,
        file,
        record,
        expired: Boolean(record) && !isLive(record!, now()),
        sessionId: record ? sessionIdFromToken(record.token) : null,
      };
    },
  };
}

/**
 * Drop every stored connection session (all scopes) for this config dir.
 * Each record is removed under its per-scope lock — the same protocol as
 * the single-scope reset — so a concurrent touch/replace that already read
 * the old record cannot recreate it right after the sweep deletes it.
 */
export function resetAllConnectionSessions(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const dir = sessionsDir(env);
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        if (
          withScopeLock(file, (stillOwner) => {
            if (!stillOwner()) return false;
            fs.rmSync(file, { force: true });
            return true;
          })
        ) {
          removed += 1;
        }
      } catch {
        // this one stays; keep sweeping the rest
      }
    }
  } catch {
    // no sessions dir yet
  }
  return removed;
}
