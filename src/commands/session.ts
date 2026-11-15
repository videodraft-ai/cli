/**
 * `videodraft render session ...`: Cloud sessions, a GPU machine you work on for a while.
 *
 *   session start [--name n] [--from-snapshot s] [--idle-minutes n] [--budget c] [--no-spot]
 *   session push <session> <path...> [--to dir]     files go up by content: unchanged ones cost nothing
 *   session run <session> <command> [--cwd dir]      shell commands and Blender scripts on the GPU machine
 *   session pull <session> [prefix] [--out dir]      bring files back
 *   session sync | status | list | pause | resume | release | logs | scene | blender
 *   session snapshot <session> <name> | snapshots | snapshot-delete <name>
 *
 * The machine bills per second while it is on (the Cloud render rate) and pauses
 * itself after its idle minutes; its files stay saved and it resumes on a new
 * machine. Waiting for a GPU is never billed.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { buildContext, compact, type CommandContext } from "../cli/context.js";
import { emit, fmt, kv, note, spinner, table } from "../cli/output.js";
import { CliError, EXIT, ToolError, UsageError } from "../core/errors.js";
import { pollRenderJob } from "../core/poll.js";
import { fileSha256, uploadResumable } from "../core/resumable-upload.js";
import { downloadUrl } from "../core/download.js";

const SKIP_NAMES = new Set([".DS_Store", "Thumbs.db"]);
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  ".cache",
]);
const SKIP_SUFFIXES = [".blend1", ".blend2", ".blend@", ".tmp", ".part"];
const BATCH = 1000;
const URL_BATCH = 500;
const UPLOAD_PARALLEL = 4;
const DOWNLOAD_PARALLEL = 6;
const TOP_UP_HINT =
  "Check your balance with `videodraft credits` or top up at https://app.videodraft.ai/pricing";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An empty file (`__init__.py`, `.gitkeep`) is one zero-length PUT that completes its upload
 *  session; uploadResumable only takes files with content. */
async function uploadEmpty(uploadUrl: string): Promise<void> {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-length": "0" },
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 200 || res.status === 201) return;
      last = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000 * 2 ** attempt);
  }
  throw new CliError(`Could not upload an empty file: ${last}.`);
}

async function call<T = any>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (error) {
    if (
      error instanceof ToolError &&
      error.exitCode !== EXIT.CREDITS &&
      (error.data as { http_status?: unknown } | undefined)?.http_status === 402
    ) {
      throw new CliError(error.message, EXIT.CREDITS, TOP_UP_HINT, error.data);
    }
    throw error;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

function positiveInt(
  value: string | undefined,
  flag: string,
  max?: number,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n < 1 || (max !== undefined && n > max)) {
    throw new UsageError(
      max === undefined
        ? `${flag} must be a whole number of at least 1.`
        : `${flag} must be a whole number from 1 to ${max}.`,
    );
  }
  return n;
}

/** A local tree to push: every regular file under each path, with its path in the session. */
export function collectFiles(
  inputs: readonly string[],
  to: string | undefined,
): { local: string; remote: string; size: number; mode: number }[] {
  const base = (to ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const out: { local: string; remote: string; size: number; mode: number }[] =
    [];
  const seen = new Set<string>();
  const add = (local: string, rel: string) => {
    const name = path.basename(local);
    if (SKIP_NAMES.has(name) || SKIP_SUFFIXES.some((s) => name.endsWith(s)))
      return;
    const st = fs.statSync(local);
    const remote = [base, rel.split(path.sep).join("/")]
      .filter(Boolean)
      .join("/");
    if (seen.has(remote))
      throw new UsageError(`Two files would land on ${remote}.`);
    seen.add(remote);
    out.push({ local, remote, size: st.size, mode: st.mode & 0o777 });
  };
  for (const input of inputs) {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) throw new UsageError(`${input} does not exist.`);
    const st = fs.statSync(abs);
    if (st.isFile()) {
      add(abs, path.basename(abs));
      continue;
    }
    if (!st.isDirectory())
      throw new UsageError(`${input} is not a file or folder.`);
    const top = path.basename(abs);
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full);
        } else if (entry.isFile()) {
          add(full, path.join(top, path.relative(abs, full)));
        }
      }
    };
    walk(abs);
  }
  return out;
}

async function sessionCall(ctx: CommandContext, args: Record<string, unknown>) {
  return call<any>(ctx.client.callTool("cloud_session", compact(args)));
}

function stateLine(s: any): string {
  const machine = s?.machine?.phase
    ? ` (${s.machine.phase}${s.machine.zone ? `, ${s.machine.zone}` : ""})`
    : "";
  return `${s?.name ? `${s.name} ` : ""}${s?.session_id}: ${s?.state}${machine}`;
}

function showSession(ctx: CommandContext, s: any) {
  emit(ctx.out, s, (o) => {
    kv(o, [
      ["session", s?.session_id],
      ["name", s?.name ?? undefined],
      ["state", s?.state],
      [
        "machine",
        s?.machine
          ? `${s.machine.phase ?? ""}${s.machine.zone ? ` in ${s.machine.zone}` : ""}`
          : undefined,
      ],
      [
        "files",
        s?.files
          ? `${s.files.count} (${formatBytes(Number(s.files.bytes ?? 0))})`
          : undefined,
      ],
      [
        "commands",
        s?.commands
          ? `${s.commands.running} running, ${s.commands.queued} queued`
          : undefined,
      ],
      [
        "cost",
        s?.cost
          ? `${s.cost.credits} credits (${Math.round(Number(s.cost.gpu_seconds ?? 0) / 60)} GPU-min)`
          : undefined,
      ],
      [
        "billing now",
        typeof s?.billing_per_minute === "number"
          ? `${s.billing_per_minute} credits/min`
          : undefined,
      ],
      [
        "idle pause",
        s?.idle_minutes
          ? `after ${s.idle_minutes} idle minute${s.idle_minutes === 1 ? "" : "s"}`
          : undefined,
      ],
      ["budget", s?.budget_credits ?? undefined],
    ]);
    if (s?.message) note(o, fmt.dim(o, String(s.message)));
  });
}

/** Wait until a session is ready (or stops trying). */
async function waitReady(
  ctx: CommandContext,
  session: string,
  timeoutMs = 45 * 60_000,
): Promise<any> {
  const spin = spinner(ctx.out, "Waiting for the session's GPU machine");
  const started = Date.now();
  let last = "";
  try {
    for (;;) {
      const s = await sessionCall(ctx, { action: "status", session });
      const line = stateLine(s);
      spin.update(line);
      if (!process.stderr.isTTY && line !== last) note(ctx.out, line);
      last = line;
      if (s?.state === "ready") return s;
      if (s?.state !== "starting") {
        throw new CliError(
          `The session is ${s?.state}: ${s?.message ?? ""}`.trim(),
        );
      }
      if (Date.now() - started > timeoutMs) {
        throw new CliError(
          "The session's machine is still not ready. It keeps its place; check `videodraft render session status`.",
        );
      }
      await sleep(5_000);
    }
  } finally {
    spin.stop();
  }
}

/** A paused session resumes first when asked to (--resume, the default for run and push). */
async function ensureReady(
  ctx: CommandContext,
  session: string,
  resume: boolean,
): Promise<any> {
  const s = await sessionCall(ctx, { action: "status", session });
  if (s?.state === "ready") return s;
  if (s?.state === "paused" && resume) {
    note(
      ctx.out,
      fmt.dim(
        ctx.out,
        "The session is paused; resuming it on a new machine (its files are saved).",
      ),
    );
    await sessionCall(ctx, { action: "resume", session });
    return waitReady(ctx, session);
  }
  if (s?.state === "starting") return waitReady(ctx, session);
  throw new CliError(`The session is ${s?.state}. ${s?.message ?? ""}`.trim());
}

async function pushFiles(
  ctx: CommandContext,
  session: string,
  inputs: string[],
  to: string | undefined,
) {
  const files = collectFiles(inputs, to);
  if (!files.length) throw new UsageError("Nothing to push.");
  const total = files.reduce((s, f) => s + f.size, 0);
  const hashing = spinner(
    ctx.out,
    `Hashing ${files.length} files (${formatBytes(total)})`,
  );
  let hashed = 0;
  const entries = await mapLimit(files, 4, async (f) => {
    const sha = await fileSha256(f.local);
    hashed++;
    hashing.update(`Hashing files: ${hashed} of ${files.length}`);
    return { ...f, sha256: sha };
  }).finally(() => hashing.stop());
  const bySha = new Map(entries.map((e) => [e.sha256, e]));
  const unique = [...bySha.values()];
  let uploaded = 0;
  let uploadedBytes = 0;
  for (let i = 0; i < unique.length; i += BATCH) {
    const part = unique.slice(i, i + BATCH);
    const plan = await call<any>(
      ctx.client.callTool("cloud_session_files", {
        action: "plan",
        session,
        files: part.map((e) => ({ sha256: e.sha256, size: e.size })),
      }),
    );
    const missing: any[] = Array.isArray(plan?.missing) ? plan.missing : [];
    const spin = spinner(ctx.out, `Uploading ${missing.length} new files`);
    try {
      await mapLimit(missing, UPLOAD_PARALLEL, async (m) => {
        const e = bySha.get(m.sha256);
        if (!e) return;
        if (e.size === 0) await uploadEmpty(String(m.upload_url));
        else await uploadResumable(String(m.upload_url), e.local);
        uploaded++;
        uploadedBytes += e.size;
        spin.update(
          `Uploaded ${uploaded} of ${missing.length} new files (${formatBytes(uploadedBytes)})`,
        );
      });
    } finally {
      spin.stop();
    }
  }
  let result: any = null;
  for (let i = 0; i < entries.length; i += BATCH) {
    result = await call<any>(
      ctx.client.callTool("cloud_session_files", {
        action: "commit",
        session,
        files: entries
          .slice(i, i + BATCH)
          .map((e) => ({
            path: e.remote,
            sha256: e.sha256,
            size: e.size,
            mode: e.mode,
          })),
      }),
    );
  }
  return {
    files: entries.length,
    uploaded,
    uploaded_bytes: uploadedBytes,
    total_bytes: total,
    session_files: result,
  };
}

async function waitCommand(
  ctx: CommandContext,
  session: string,
  commandId: string,
  stream: boolean,
): Promise<any> {
  let printedBytes = 0;
  let delay = 1_500;
  for (;;) {
    const c = await call<any>(
      ctx.client.callTool("cloud_session_command", {
        action: "status",
        session,
        command_id: commandId,
      }),
    );
    if (stream && !ctx.out.json) {
      const tail = String(c?.log_tail ?? "");
      const bytes = Number(c?.log_bytes ?? 0);
      if (bytes > printedBytes && tail) {
        const fresh = bytes - printedBytes;
        process.stderr.write(
          fresh >= tail.length
            ? (printedBytes ? "…\n" : "") + tail
            : tail.slice(tail.length - fresh),
        );
        printedBytes = bytes;
      }
    }
    if (!["queued", "running"].includes(String(c?.status))) return c;
    await sleep(delay);
    delay = Math.min(5_000, delay + 500);
  }
}

async function pullFiles(
  ctx: CommandContext,
  session: string,
  prefix: string | undefined,
  outDir: string,
) {
  const all: any[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await call<any>(
      ctx.client.callTool(
        "cloud_session_files",
        compact({ action: "list", session, prefix, after, limit: 5000 }),
      ),
    );
    all.push(...(Array.isArray(page?.files) ? page.files : []));
    after = page?.next_after ?? undefined;
    if (!after) break;
  }
  if (!all.length)
    throw new CliError(
      `No saved files${prefix ? ` under ${prefix}` : ""}. Run \`videodraft render session sync\` if a command just made them.`,
    );
  // Skip files already here with the same content.
  const need: any[] = [];
  for (const f of all) {
    const dest = path.join(outDir, ...String(f.path).split("/"));
    if (
      fs.existsSync(dest) &&
      fs.statSync(dest).size === Number(f.size) &&
      (await fileSha256(dest)) === f.sha256
    )
      continue;
    need.push({ ...f, dest });
  }
  const spin = spinner(ctx.out, `Downloading ${need.length} files`);
  let done = 0;
  try {
    for (let i = 0; i < need.length; i += URL_BATCH) {
      const part = need.slice(i, i + URL_BATCH);
      const r = await call<any>(
        ctx.client.callTool("cloud_session_files", {
          action: "urls",
          session,
          paths: part.map((f) => f.path),
        }),
      );
      const urls = new Map<string, string>(
        (r?.files ?? [])
          .filter((f: any) => f?.url)
          .map((f: any) => [f.path, f.url]),
      );
      await mapLimit(part, DOWNLOAD_PARALLEL, async (f) => {
        const url = urls.get(f.path);
        if (!url) return;
        await downloadUrl(url, f.dest);
        try {
          fs.chmodSync(f.dest, Number(f.mode ?? 0o644) & 0o777);
        } catch {
          // permissions are best effort
        }
        done++;
        spin.update(`Downloaded ${done} of ${need.length} files`);
      });
    }
  } finally {
    spin.stop();
  }
  return {
    files: all.length,
    downloaded: done,
    skipped: all.length - need.length,
    out: outDir,
  };
}

export function registerSessionCommands(program: Command): void {
  // Under `render`, next to the machines it shares billing and the stop button with (and away
  // from `sessions`, which are AI Studio's). Hidden from help until Cloud sessions open to every
  // account: a CLI published before then works for accounts that have them and points nobody else.
  const render = program.commands.find((c) => c.name() === "render");
  if (!render)
    throw new Error(
      "registerRenderCommands must run before registerSessionCommands",
    );
  const s = render
    .command("session", { hidden: true })
    .description(
      "Cloud sessions: a GPU machine you work on (files, commands, Blender scripts), paused when idle",
    );

  s.command("start")
    .description(
      "Start a session on a cloud GPU machine (billed per second while on; waiting for a GPU is not billed)",
    )
    .option("--name <name>", "a name to use instead of the session id")
    .option("--from-snapshot <name>", "begin with the files of this snapshot")
    .option(
      "--idle-minutes <n>",
      "minutes without work before it pauses itself (default 15)",
    )
    .option(
      "--budget <credits>",
      "pause once the session has cost this many credits",
    )
    .option("--no-spot", "wait for a regular GPU only")
    .option("--no-wait", "return at once instead of waiting for the machine")
    .action(async function (this: Command) {
      const o = this.opts<{
        name?: string;
        fromSnapshot?: string;
        idleMinutes?: string;
        budget?: string;
        spot?: boolean;
        wait?: boolean;
      }>();
      const ctx = buildContext(this);
      const budget = o.budget === undefined ? undefined : Number(o.budget);
      if (budget !== undefined && !(budget > 0))
        throw new UsageError("--budget must be a positive number of credits.");
      let st = await sessionCall(ctx, {
        action: "start",
        name: o.name,
        from_snapshot: o.fromSnapshot,
        idle_minutes: positiveInt(o.idleMinutes, "--idle-minutes", 1440),
        budget_credits: budget,
        spot: o.spot === false ? "never" : undefined,
      });
      if (o.wait !== false) st = await waitReady(ctx, String(st.session_id));
      showSession(ctx, st);
    });

  s.command("status <session>")
    .description("Show a session (id or name)")
    .action(async function (this: Command, session: string) {
      const ctx = buildContext(this);
      showSession(ctx, await sessionCall(ctx, { action: "status", session }));
    });

  s.command("list")
    .description("List your sessions, running and paused first")
    .option("--name <name>", "only sessions of this name")
    .option("--limit <n>", "how many (default 20)")
    .action(async function (this: Command) {
      const o = this.opts<{ name?: string; limit?: string }>();
      const ctx = buildContext(this);
      const r = await sessionCall(ctx, {
        action: "list",
        name: o.name,
        limit: positiveInt(o.limit, "--limit", 100),
      });
      emit(ctx.out, r, (out) => {
        const rows: any[] = Array.isArray(r?.sessions) ? r.sessions : [];
        if (!rows.length)
          return note(
            out,
            "No sessions yet. Start one with `videodraft render session start`.",
          );
        table(
          out,
          ["session", "name", "state", "files", "cost", "created"],
          rows.map((x) => [
            String(x.session_id),
            String(x.name ?? ""),
            String(x.state),
            `${x.files?.count ?? 0}`,
            `${x.cost?.credits ?? 0}`,
            String(x.created_at ?? "")
              .slice(0, 16)
              .replace("T", " "),
          ]),
        );
      });
    });

  for (const [name, verb, help] of [
    [
      "pause",
      "pause",
      "Save the session's files and switch its machine off (resume later)",
    ],
    [
      "resume",
      "resume",
      "Resume a paused session on a new machine with its saved files",
    ],
    [
      "release",
      "release",
      "Save and release the session (its files stay 30 days; snapshot to keep a copy)",
    ],
  ] as const) {
    s.command(`${name} <session>`)
      .description(help)
      .option("--no-wait", "return at once")
      .action(async function (this: Command, session: string) {
        const o = this.opts<{ wait?: boolean }>();
        const ctx = buildContext(this);
        let st = await sessionCall(ctx, { action: verb, session });
        if (o.wait !== false && verb === "resume")
          st = await waitReady(ctx, session);
        if (o.wait !== false && verb !== "resume") {
          for (
            let i = 0;
            i < 120 &&
            ["pausing", "releasing", "ready"].includes(String(st?.state));
            i++
          ) {
            await sleep(3_000);
            st = await sessionCall(ctx, { action: "status", session });
          }
        }
        showSession(ctx, st);
      });
  }

  s.command("push <session> <paths...>")
    .description(
      "Send files or folders to the session (unchanged contents are not uploaded again)",
    )
    .option("--to <dir>", "folder inside the session (default: the top folder)")
    .action(async function (this: Command, session: string, paths: string[]) {
      const o = this.opts<{ to?: string }>();
      const ctx = buildContext(this);
      const r = await pushFiles(ctx, session, paths, o.to);
      emit(ctx.out, r, (out) =>
        note(
          out,
          `Pushed ${r.files} files (${formatBytes(r.total_bytes)}); uploaded ${r.uploaded} new (${formatBytes(r.uploaded_bytes)}).`,
        ),
      );
    });

  s.command("run <session> <command...>")
    .description(
      "Run a shell command on the session's machine and stream its output (Blender: `blender -b ...`)",
    )
    .option("--cwd <dir>", "folder inside the session to run in")
    .option("--timeout <seconds>", "stop the command after this long")
    .option("--detach", "start it and print the command id without waiting")
    .option("--no-resume", "fail instead of resuming a paused session")
    .action(async function (this: Command, session: string, command: string[]) {
      const o = this.opts<{
        cwd?: string;
        timeout?: string;
        detach?: boolean;
        resume?: boolean;
      }>();
      const ctx = buildContext(this);
      await ensureReady(ctx, session, o.resume !== false);
      const c = await call<any>(
        ctx.client.callTool(
          "cloud_session_command",
          compact({
            action: "run",
            session,
            command: command.join(" "),
            cwd: o.cwd,
            timeout_s: positiveInt(o.timeout, "--timeout"),
          }),
        ),
      );
      if (o.detach)
        return emit(ctx.out, c, (out) =>
          note(
            out,
            `Started ${c.command_id}. Follow it with \`videodraft render session logs ${session} ${c.command_id}\`.`,
          ),
        );
      const done = await waitCommand(ctx, session, String(c.command_id), true);
      emit(ctx.out, done, (out) => {
        if (!String(done?.log_tail ?? "").endsWith("\n"))
          process.stderr.write("\n");
        note(
          out,
          fmt.dim(
            out,
            `${done.command_id}: ${done.status}${done.exit_code !== null && done.exit_code !== undefined ? ` (exit ${done.exit_code})` : ""}${done.error ? `: ${done.error}` : ""}`,
          ),
        );
      });
      if (done?.status !== "done") {
        // The remote exit code is in the output; the CLI's own codes 2 to 4 mean usage, sign-in
        // and credits, so a failed command always exits 1 here.
        process.exitCode = EXIT.ERROR;
      }
    });

  s.command("logs <session> <command_id>")
    .description(
      "Show a command's status and output (the whole log once it has finished)",
    )
    .option("--follow", "keep printing until it finishes")
    .action(async function (this: Command, session: string, commandId: string) {
      const o = this.opts<{ follow?: boolean }>();
      const ctx = buildContext(this);
      const c = o.follow
        ? await waitCommand(ctx, session, commandId, true)
        : await call<any>(
            ctx.client.callTool("cloud_session_command", {
              action: "status",
              session,
              command_id: commandId,
            }),
          );
      if (ctx.out.json) return emit(ctx.out, c);
      if (!o.follow) {
        if (c?.log_url) {
          const res = await fetch(String(c.log_url));
          process.stdout.write(
            res.ok ? await res.text() : String(c.log_tail ?? ""),
          );
        } else process.stdout.write(String(c?.log_tail ?? ""));
      }
      note(
        ctx.out,
        fmt.dim(
          ctx.out,
          `${c.command_id}: ${c.status}${c.exit_code !== null && c.exit_code !== undefined ? ` (exit ${c.exit_code})` : ""}`,
        ),
      );
    });

  s.command("sync <session>")
    .description(
      "Save what commands changed on the machine (it also saves after every command)",
    )
    .action(async function (this: Command, session: string) {
      const ctx = buildContext(this);
      const r = await sessionCall(ctx, { action: "sync", session });
      const done = await waitCommand(ctx, session, String(r.command_id), false);
      emit(ctx.out, done, (out) =>
        note(out, String(done?.log_tail ?? done?.status).trim()),
      );
      if (done?.status !== "done") process.exitCode = 1;
    });

  s.command("pull <session> [prefix]")
    .description("Download the session's saved files (or one folder)")
    .option("--out <dir>", "where to put them (default: the current folder)")
    .action(async function (this: Command, session: string, prefix?: string) {
      const o = this.opts<{ out?: string }>();
      const ctx = buildContext(this);
      const r = await pullFiles(
        ctx,
        session,
        prefix,
        path.resolve(o.out ?? "."),
      );
      emit(ctx.out, r, (out) =>
        note(
          out,
          `Downloaded ${r.downloaded} files to ${r.out} (${r.skipped} already here).`,
        ),
      );
    });

  s.command("scene <session> <path>")
    .description(
      "Make a .blend in the session a Cloud render scene; prints its scene_sha",
    )
    .action(async function (this: Command, session: string, file: string) {
      const ctx = buildContext(this);
      const r = await sessionCall(ctx, {
        action: "scene",
        session,
        path: file,
      });
      emit(ctx.out, r, (out) =>
        kv(out, [
          ["scene_sha", r.scene_sha],
          ["path", r.path],
          ["size", formatBytes(Number(r.size ?? 0))],
        ]),
      );
    });

  s.command("blender <session> <path>")
    .description(
      "Render a .blend from the session on Cloud render (no upload from this computer) and download the MP4",
    )
    .requiredOption(
      "--frames <range>",
      "frames to render, e.g. 1-240 (inclusive)",
    )
    .option("--name <name>", "a label for the job")
    .option("--gpu <size>", "GPU size from `render prices` (default full)")
    .option("--procs <n>", "Blender processes in parallel on the GPU, 1-4")
    .option("--blender <version>", "Blender version: 5.2 (default) or 4.5")
    .option("--no-spot", "wait for a regular GPU only")
    .option(
      "--out <path>",
      "file or folder for the clip (default media/renders/<job>.mp4)",
    )
    .option("--no-wait", "submit and print the job id without waiting")
    .action(async function (this: Command, session: string, file: string) {
      const o = this.opts<{
        frames: string;
        name?: string;
        gpu?: string;
        procs?: string;
        blender?: string;
        spot?: boolean;
        out?: string;
        wait?: boolean;
      }>();
      const ctx = buildContext(this);
      const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(o.frames);
      if (!m)
        throw new UsageError(
          "--frames must be a range like 1-240 or one frame like 42.",
        );
      const start = Number(m[1]);
      const end = m[2] === undefined ? start : Number(m[2]);
      if (end < start)
        throw new UsageError("--frames: the last frame is before the first.");
      const scene = await sessionCall(ctx, {
        action: "scene",
        session,
        path: file,
      });
      const job = await call<any>(
        ctx.client.callTool(
          "cloud_render_submit",
          compact({
            scene_sha: scene.scene_sha,
            start,
            end,
            name: o.name,
            gpu: o.gpu,
            procs: positiveInt(o.procs, "--procs", 4),
            blender_version: o.blender,
            spot: o.spot === false ? "never" : undefined,
          }),
        ),
      );
      const jobId = String(job?.job_id ?? "");
      if (!jobId)
        throw new CliError("cloud_render_submit did not return a job_id.");
      if (o.wait === false)
        return emit(ctx.out, job, (out) =>
          note(
            out,
            `Submitted ${jobId}. Wait for it with \`videodraft render wait ${jobId}\`.`,
          ),
        );
      const spin = spinner(ctx.out, `Rendering ${jobId}`);
      let final: any;
      try {
        final = await pollRenderJob(ctx.client, jobId, {
          onTick: (p: any) =>
            spin.update(
              `${jobId}: ${p?.status ?? ""} ${p?.message ?? ""}`.trim(),
            ),
        });
      } finally {
        spin.stop();
      }
      if (final?.status !== "done" || !final?.clip_url) {
        throw new CliError(
          `${jobId} ended ${final?.status}: ${final?.error ?? final?.message ?? ""}`.trim(),
        );
      }
      const dest = o.out
        ? fs.existsSync(o.out) && fs.statSync(o.out).isDirectory()
          ? path.join(o.out, `${jobId}.mp4`)
          : o.out
        : path.join("media", "renders", `${jobId}.mp4`);
      const saved = await downloadUrl(String(final.clip_url), dest);
      emit(ctx.out, { ...final, saved: saved.path }, (out) =>
        note(out, `Saved ${saved.path} (${formatBytes(saved.bytes)}).`),
      );
    });

  s.command("snapshot <session> <name>")
    .description(
      "Save a named copy of the session's files (kept 30 days) to start sessions from",
    )
    .option("--replace", "overwrite a snapshot of the same name")
    .action(async function (this: Command, session: string, name: string) {
      const o = this.opts<{ replace?: boolean }>();
      const ctx = buildContext(this);
      const r = await call<any>(
        ctx.client.callTool(
          "cloud_session_snapshot",
          compact({
            action: "create",
            session,
            name,
            replace: o.replace ? true : undefined,
          }),
        ),
      );
      emit(ctx.out, r, (out) =>
        note(
          out,
          `Snapshot ${r.name}: ${r.files} files (${formatBytes(Number(r.bytes ?? 0))}), kept until ${String(r.expires_at).slice(0, 10)}.`,
        ),
      );
    });

  s.command("snapshots")
    .description("List your snapshots")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const r = await call<any>(
        ctx.client.callTool("cloud_session_snapshot", { action: "list" }),
      );
      emit(ctx.out, r, (out) => {
        const rows: any[] = Array.isArray(r?.snapshots) ? r.snapshots : [];
        if (!rows.length) return note(out, "No snapshots yet.");
        table(
          out,
          ["name", "files", "size", "created", "kept until"],
          rows.map((x) => [
            String(x.name),
            `${x.files}`,
            formatBytes(Number(x.bytes ?? 0)),
            String(x.created_at).slice(0, 16).replace("T", " "),
            String(x.expires_at).slice(0, 10),
          ]),
        );
      });
    });

  s.command("snapshot-delete <name>")
    .description("Delete a snapshot")
    .action(async function (this: Command, name: string) {
      const ctx = buildContext(this);
      const r = await call<any>(
        ctx.client.callTool("cloud_session_snapshot", {
          action: "delete",
          name,
        }),
      );
      emit(ctx.out, r, (out) => note(out, `Deleted snapshot ${name}.`));
    });
}
