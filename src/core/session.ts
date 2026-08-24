/**
 * Connection sessions for the CLI.
 *
 * The VideoDraft MCP server hands every connection an `Mcp-Session-Id` on
 * `initialize` and files that connection's project-less generations into its
 * own AI Studio session (named after the client and date). MCP hosts echo the
 * header for free; the CLI is stateless per invocation, so it keeps the
 * header in a small store and replays it on every request.
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
import { createHash } from "node:crypto";
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
   * one directory never ends up split across two sessions.
   */
  save(token: string): string;
  /** Replace the scope's token unconditionally (server re-mint). */
  replace(token: string): void;
  /** Forget the current token; the next call re-initialises. */
  reset(): void;
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

/**
 * Claim an EMPTY scope atomically (O_EXCL). Returns false when another
 * process already holds it, in which case the caller adopts that record.
 */
function claimRecord(file: string, record: ConnectionSessionRecord): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch (err: any) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
}

function isLive(record: ConnectionSessionRecord, nowMs: number): boolean {
  const idle = nowMs - Date.parse(record.lastUsedAt);
  return Number.isFinite(idle) && idle <= SESSION_IDLE_MS;
}

/** How long a reclaim lock may exist before it is considered abandoned. */
const RECLAIM_LOCK_STALE_MS = 2_000;
/** How long a reclaim loser waits for the holder's record before giving up. */
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
function acquireReclaimLock(file: string): boolean {
  const lock = `${file}.lock`;
  try {
    fs.writeFileSync(lock, String(process.pid), { mode: 0o600, flag: "wx" });
    return true;
  } catch (err: any) {
    if (err?.code !== "EEXIST") return false;
    try {
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age <= RECLAIM_LOCK_STALE_MS) return false;
      // Atomically claim the right to break THIS stale lock.
      const claimed = `${lock}.break.${process.pid}`;
      fs.renameSync(lock, claimed);
      fs.rmSync(claimed, { force: true });
      fs.writeFileSync(lock, String(process.pid), {
        mode: 0o600,
        flag: "wx",
      });
      return true;
    } catch {
      // lost the rename (ENOENT) or someone re-locked first
      return false;
    }
  }
}

function releaseReclaimLock(file: string): void {
  try {
    fs.rmSync(`${file}.lock`, { force: true });
  } catch {
    // best-effort
  }
}

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
      // Touch, best-effort: keeps an active piece of work on one session
      // across days instead of rotating at a fixed age. The re-read + write
      // must be exclusive, or a concurrent reset/replace landing between them
      // is undone by this stale copy (resurrecting a reset token, or
      // discarding a server re-mint). No lock available → skip the touch;
      // it only shortens this scope's idle window, never corrupts it.
      if (acquireReclaimLock(file)) {
        try {
          const current = readRecord(file);
          if (current && current.token === record.token) {
            writeRecord(file, {
              ...current,
              lastUsedAt: new Date(now()).toISOString(),
            });
          }
        } catch {
          // read-only config dir → still usable for this invocation
        } finally {
          releaseReclaimLock(file);
        }
      }
      return record.token;
    },
    save(token) {
      try {
        if (claimRecord(file, fresh(token))) return token;
        // Lost the claim: adopt the winner unless its record is dead.
        const winner = readRecord(file);
        if (winner && isLive(winner, now())) return winner.token;
        // Expired record: replacing it must be exclusive, or two processes
        // reclaiming at the same moment each keep their own token (rm+claim
        // alone is not enough — B can rm A's fresh claim). The holder of the
        // per-scope lock installs its record; everyone else waits briefly
        // and adopts whatever live record appears.
        if (acquireReclaimLock(file)) {
          try {
            const current = readRecord(file);
            if (current && isLive(current, now())) return current.token;
            writeRecord(file, fresh(token));
            return token;
          } finally {
            releaseReclaimLock(file);
          }
        }
        const deadline = Date.now() + RECLAIM_WAIT_MS;
        while (Date.now() < deadline) {
          const current = readRecord(file);
          if (current && isLive(current, now())) return current.token;
          sleepSync(RECLAIM_POLL_MS);
        }
        return token; // holder vanished mid-reclaim → keep ours for this run
      } catch {
        return token; // fail soft: this invocation still sends the header
      }
    },
    replace(token) {
      try {
        writeRecord(file, fresh(token));
      } catch {
        // fail soft
      }
    },
    reset() {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // nothing to forget
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

/** Drop every stored connection session (all scopes) for this config dir. */
export function resetAllConnectionSessions(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const dir = sessionsDir(env);
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      fs.rmSync(path.join(dir, name), { force: true });
      removed += 1;
    }
  } catch {
    // no sessions dir yet
  }
  return removed;
}
