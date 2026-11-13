/**
 * `videodraft render ...`: Cloud render, Blender scenes on a cloud GPU.
 *
 *   render blender <scene.blend> --frames a-b [--name <label>]
 *       hash, upload once (resumable chunks), submit, wait, download the MP4
 *   render status | wait | cancel | resume <job id or name>
 *   render list [--name <label>] | machine | stop | prices
 *
 * Every job gets its own machine, so several render at once. A job first waits
 * for Google to hand over a GPU, which is never billed; the machine then bills
 * per second while it is on and switches itself off 1 minute after its last job
 * (`render stop` switches every machine off at once). Output says so wherever a
 * wait could look like money burning. The rate comes from the server
 * (`render prices`), never from this file.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { buildContext, compact, type CommandContext } from "../cli/context.js";
import { emit, fmt, kv, note, spinner, table } from "../cli/output.js";
import { CliError, EXIT, ToolError, UsageError } from "../core/errors.js";
import { pollRenderJob } from "../core/poll.js";
import { fileSha256, uploadResumable } from "../core/resumable-upload.js";
import { downloadUrl, extFromUrl, savedLine } from "../core/download.js";

const BLENDER_VERSIONS = ["5.2", "4.5"];
const GPU_SIZES = ["full", "half", "quarter"];
const DEFAULT_OUT_DIR = path.join("media", "renders");
const RENDER_POLL_MS = 10_000;
const IDLE_SHUTDOWN = "1 minute";
const JOB_ID = /^job_[0-9a-f]{16}$/;
const MAX_NAME = 80;
// After this long without a GPU, say once that long waits are normal and free.
const REASSURE_AFTER_SECONDS = 300;
const TOP_UP_HINT =
  "Check your balance with `videodraft credits` or top up at https://app.videodraft.ai/pricing";
const STOP_STEP = `The GPU bills until it switches itself off ${IDLE_SHUTDOWN} after its last job; run \`videodraft render stop\` once no more renders are needed.`;
const WAIT_NOTE =
  "Waiting for a GPU is not billed. Billing starts when Google hands a machine over, about 15 seconds before it renders.";

/** "1-240" (inclusive) or a single frame, "42". */
export function parseFrameRange(value: string): { start: number; end: number } {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(value);
  if (!match) {
    throw new UsageError(
      `--frames must be a frame range like 1-240, or one frame like 42 (got "${value}").`,
    );
  }
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new UsageError(`--frames ${value} is out of range.`);
  }
  if (end < start) {
    throw new UsageError(
      `--frames ${value}: the last frame is before the first.`,
    );
  }
  return { start, end };
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

/** --name as the server will store it: single spaces, at most 80 characters, never an id. */
export function jobNameOption(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = value.replace(/\s+/g, " ").trim();
  if (!name) throw new UsageError("--name must not be empty.");
  if ([...name].length > MAX_NAME) {
    throw new UsageError(`--name must be at most ${MAX_NAME} characters.`);
  }
  if (JOB_ID.test(name.toLowerCase())) {
    throw new UsageError("--name must not look like a job id.");
  }
  return name;
}

/**
 * The name a job gets without --name: the scene's file name and the frames
 * ("main_v8 845-1350"), so `render list` says what each job is.
 */
export function defaultJobName(
  file: string,
  frames: { start: number; end: number },
): string {
  const stem = path.basename(file).replace(/\.blend$/i, "") || "scene";
  const range =
    frames.start === frames.end
      ? `${frames.start}`
      : `${frames.start}-${frames.end}`;
  const room = MAX_NAME - range.length - 1;
  const chars = [...stem];
  return `${chars.length > room ? chars.slice(0, room).join("") : stem} ${range}`;
}

function jobLabel(id: string, name?: unknown): string {
  return typeof name === "string" && name ? `${id} (${name})` : id;
}

/** Where a finished clip goes: a file path as given, else <dir>/<job_id>.mp4. */
export function renderOutputPath(
  out: string | undefined,
  jobId: string,
  clipUrl: string,
): string {
  const name = `${jobId}.${extFromUrl(clipUrl, "mp4")}`;
  if (!out) return path.join(DEFAULT_OUT_DIR, name);
  return path.extname(out) ? out : path.join(out, name);
}

/**
 * A 402 from the GPU service is a credit refusal whatever its wording. The
 * server already words it so ToolError exits 4; this keeps older servers and
 * odd wordings on the same exit code.
 */
async function renderCall<T = any>(call: Promise<T>): Promise<T> {
  try {
    return await call;
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

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function segmentsText(job: any): string | undefined {
  if (typeof job?.segments_total !== "number") return undefined;
  return `${job.segments_done ?? 0}/${job.segments_total} segments`;
}

export function costText(job: any): string | undefined {
  const cost = job?.cost;
  if (typeof cost?.credits !== "number") return undefined;
  if (cost.final === true) return `${cost.credits} credits`;
  if (
    job?.status === "queued" &&
    job?.machine?.phase === "waiting" &&
    cost.credits === 0 &&
    cost.gpu_seconds === 0
  ) {
    return "nothing yet (waiting for a GPU is not billed)";
  }
  const estimate = cost.estimated_total_credits;
  if (typeof estimate !== "number") return `${cost.credits} credits so far`;
  if (job?.status === "done" || job?.status === "cancelled") {
    return `${cost.credits} credits so far, about ${estimate} once its machine switches off`;
  }
  return `${cost.credits} credits so far, about ${estimate} in total${typeof cost.estimated_minutes_left === "number" ? `, ${cost.estimated_minutes_left} min left` : ""}`;
}

/** Where a job's billed GPU time went, when the server says. */
export function billedText(job: any): string | undefined {
  const c = job?.cost;
  if (typeof c?.gpu_seconds !== "number" || c.gpu_seconds <= 0)
    return undefined;
  const parts: string[] = [];
  if (typeof c.start_up_seconds === "number" && c.start_up_seconds > 0) {
    parts.push(`start-up ${formatDuration(c.start_up_seconds)}`);
  }
  if (typeof c.render_seconds === "number") {
    parts.push(`rendering ${formatDuration(c.render_seconds)}`);
  }
  // A job that hands its machine to the next one has a second or so here; not worth a word.
  if (typeof c.idle_seconds === "number" && c.idle_seconds >= 5) {
    parts.push(`idle before switch-off ${formatDuration(c.idle_seconds)}`);
  }
  return `${formatDuration(c.gpu_seconds)} of GPU time${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

/** The time a job spent waiting for Google to hand over a GPU. */
export function waitedText(job: any): string | undefined {
  const s = job?.wait_seconds;
  if (typeof s !== "number" || s < 1) return undefined;
  return `${formatDuration(s)} for a GPU, not billed`;
}

/** What a job is doing, in a few words that never make a free wait sound billed. */
export function stateText(job: any): string {
  const status = String(job?.status ?? "unknown");
  if (status === "queued") {
    switch (job?.machine?.phase) {
      case "waiting":
        return "waiting for a free GPU (not billed)";
      case "starting":
        return "a GPU is starting for queued jobs (billed)";
      case "idle":
        return "a machine is picking up queued work";
      case "rendering":
        return "waiting for one of your machines";
      default:
        return "queued";
    }
  }
  if (status === "running") {
    const segments = segmentsText(job);
    return `rendering${segments ? ` (${segments})` : ""}`;
  }
  return status;
}

const PHASE_WORDS: Record<string, string> = {
  rendering: "rendering",
  starting: "starting up",
  idle: "idle",
  waiting: "waiting for a GPU (not billed)",
  stopping: "switching off",
};

/** "1 rendering, 5 waiting for a GPU (not billed)": what a user's machines are doing. */
export function machinesDoing(machines: any[]): string {
  const counts = new Map<string, number>();
  for (const m of machines) {
    const phase =
      typeof m?.phase === "string" ? m.phase : String(m?.state ?? "");
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  const order = Object.keys(PHASE_WORDS);
  const rank = (p: string) =>
    order.includes(p) ? order.indexOf(p) : order.length;
  return [...counts.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([p, n]) => `${n} ${PHASE_WORDS[p] ?? p}`)
    .join(", ");
}

/** "6 machines: 1 rendering, 5 waiting for a GPU (not billed)". */
export function machinesSummary(machines: any[]): string {
  if (!machines.length) return "none";
  return `${machines.length} machine${machines.length === 1 ? "" : "s"}: ${machinesDoing(machines)}`;
}

function spentText(pair: any): string | undefined {
  if (typeof pair?.seconds !== "number" || typeof pair?.credits !== "number") {
    return undefined;
  }
  return `${Number(pair.credits.toFixed(2))} credits for ${formatDuration(pair.seconds)} of GPU time`;
}

/** Clear a live spinner line before printing a log line under it. */
function logLine(ctx: CommandContext, message: string): void {
  if (!ctx.out.json && process.stderr.isTTY) process.stderr.write("\r\x1b[2K");
  note(ctx.out, message);
}

async function uploadScene(
  ctx: CommandContext,
  uploadUrl: string,
  file: string,
  size: number,
): Promise<void> {
  const label = path.basename(file);
  const spin = spinner(ctx.out, `Uploading ${label}`);
  let lastLogged = -1;
  try {
    await uploadResumable(uploadUrl, file, {
      onProgress: (stored, total) => {
        const percent = Math.floor((stored / total) * 100);
        const text = `Uploading ${label}: ${formatBytes(stored)} of ${formatBytes(total)} (${percent}%)`;
        spin.update(text);
        // Without a terminal the spinner is silent, so log confirmed chunks.
        if (!process.stderr.isTTY && percent !== lastLogged) {
          lastLogged = percent;
          note(ctx.out, text);
        }
      },
    });
  } finally {
    spin.stop();
  }
  note(ctx.out, fmt.dim(ctx.out, `Uploaded ${label} (${formatBytes(size)}).`));
}

function stopHint(ctx: CommandContext): void {
  note(
    ctx.out,
    fmt.dim(
      ctx.out,
      `The GPU switches itself off ${IDLE_SHUTDOWN} after its last job. Run \`videodraft render stop\` when you are done.`,
    ),
  );
}

const OPEN = new Set(["queued", "running", "paused"]);
const RESUMABLE = new Set(["paused", "failed"]);

/**
 * A job id as given, or the job with that name (ignoring case): the newest one,
 * or for cancel and resume the one job it can act on. When two jobs of that
 * name qualify, it refuses rather than guess.
 */
export async function resolveJob(
  ctx: CommandContext,
  ref: string,
  purpose: "any" | "cancel" | "resume" = "any",
): Promise<string> {
  const given = ref.replace(/\s+/g, " ").trim();
  if (JOB_ID.test(given)) return given;
  if (!given) throw new UsageError("Give a job id (job_...) or a job name.");
  const result = await renderCall(
    ctx.client.callTool("cloud_render_list", { name: given, limit: 100 }),
  );
  const wanted = given.toLowerCase();
  const jobs: any[] = (Array.isArray(result?.jobs) ? result.jobs : [])
    .filter(
      (j: any) =>
        typeof j?.job_id === "string" &&
        typeof j?.name === "string" &&
        j.name.toLowerCase() === wanted,
    )
    .sort((a: any, b: any) =>
      String(b?.created_at ?? "").localeCompare(String(a?.created_at ?? "")),
    );
  if (!jobs.length) {
    throw new CliError(
      `No render job is named "${given}".`,
      EXIT.ERROR,
      "See your jobs and their names with: videodraft render list",
    );
  }
  const able =
    purpose === "cancel"
      ? jobs.filter((j) => OPEN.has(j.status))
      : purpose === "resume"
        ? jobs.filter((j) => RESUMABLE.has(j.status))
        : [];
  if (able.length > 1) {
    throw new CliError(
      `${able.length} jobs named "${given}" can be ${purpose === "cancel" ? "cancelled" : "resumed"}: ${able.map((j) => j.job_id).join(", ")}.`,
      EXIT.USAGE,
      `Pick one by its job id, e.g. videodraft render ${purpose} ${able[0].job_id}`,
    );
  }
  const job = able[0] ?? jobs[0];
  note(ctx.out, fmt.dim(ctx.out, `"${given}" is ${job.job_id}.`));
  return job.job_id;
}

/**
 * Why a job paused. The service sends `pause_reason`; servers without it only
 * have the error text, and before either existed every pause was for credits.
 */
export function pauseReason(job: any): "credits" | "daily_limit" | "user" {
  const reason = typeof job?.pause_reason === "string" ? job.pause_reason : "";
  if (reason === "daily_limit" || reason === "user") return reason;
  if (reason === "credits" || reason === "low_credits") return "credits";
  const text = typeof job?.error === "string" ? job.error : "";
  if (/daily/i.test(text)) return "daily_limit";
  if (/machine was stopped/i.test(text)) return "user";
  return "credits";
}

/** Poll until the job stops moving, then download the clip or fail with the right exit code. */
async function waitAndDownload(
  ctx: CommandContext,
  jobId: string,
  out: string | undefined,
  extra: Record<string, unknown> = {},
): Promise<void> {
  // Renders can run for hours: no time limit unless --wait-timeout is given.
  const intervalMs = ctx.flags.waitInterval ? ctx.intervalMs : RENDER_POLL_MS;
  const timeoutMs = ctx.flags.waitTimeout
    ? ctx.timeoutMs
    : Number.POSITIVE_INFINITY;
  const startedAt = Date.now();
  let label = jobLabel(jobId, extra.name);
  const spin = spinner(ctx.out, `${label}: waiting`);
  let last = "";
  let reassured = false;
  let job: any;
  try {
    job = await pollRenderJob(ctx.client, jobId, {
      intervalMs,
      timeoutMs,
      onTick: (payload) => {
        label = jobLabel(jobId, payload?.name ?? extra.name);
        const state = stateText(payload);
        const cost =
          payload?.status === "running" ? costText(payload) : undefined;
        spin.update(
          `${label}: ${state}${cost ? ` · ${cost}` : ""} · ${formatDuration((Date.now() - startedAt) / 1000)}`,
        );
        if (state !== last) {
          last = state;
          logLine(ctx, `${label}: ${state}`);
        }
        const queuedSeconds =
          typeof payload?.queued_seconds === "number"
            ? payload.queued_seconds
            : payload?.wait_seconds;
        if (
          !reassured &&
          payload?.status === "queued" &&
          payload?.machine?.phase === "waiting" &&
          typeof queuedSeconds === "number" &&
          queuedSeconds > REASSURE_AFTER_SECONDS
        ) {
          reassured = true;
          logLine(
            ctx,
            fmt.dim(
              ctx.out,
              `${label}: queued for ${formatDuration(queuedSeconds)}. Waiting for a GPU is not billed; at busy times it can take longer, and the job keeps its place.`,
            ),
          );
        }
      },
    });
  } finally {
    spin.stop();
  }

  const status = String(job?.status ?? "unknown");
  if (status === "paused") {
    if (pauseReason(job) === "credits") {
      throw new CliError(
        `Render ${jobId} paused: the account ran out of credits. Finished segments are kept.`,
        EXIT.CREDITS,
        `Top up at https://app.videodraft.ai/pricing, then run: videodraft render resume ${jobId}`,
        job,
      );
    }
    // The daily limit or a machine stop: not a billing problem, so not the credits exit code.
    const why =
      typeof job?.error === "string" && job.error
        ? job.error
        : "the Cloud render machine was stopped.";
    throw new CliError(
      `Render ${jobId} paused: ${why} Finished segments are kept.`,
      EXIT.ERROR,
      `Continue it with: videodraft render resume ${jobId}`,
      job,
    );
  }
  if (status === "failed") {
    throw new CliError(
      `Render ${jobId} failed: ${job?.error ?? "unknown error"}`,
      EXIT.ERROR,
      `Retry its unfinished segments with: videodraft render resume ${jobId}`,
      job,
    );
  }
  if (status === "cancelled") {
    throw new CliError(
      `Render ${jobId} was cancelled.`,
      EXIT.ERROR,
      undefined,
      job,
    );
  }
  const clipUrl = job?.clip_url;
  if (typeof clipUrl !== "string" || !clipUrl) {
    throw new CliError(
      `Render ${jobId} finished without a clip_url.`,
      EXIT.ERROR,
      `Check it with: videodraft render status ${jobId}`,
      job,
    );
  }
  const file = await downloadUrl(
    clipUrl,
    renderOutputPath(out, jobId, clipUrl),
  );
  // --json hides the stderr hints, so the document carries the next step in
  // CLI terms instead of the server's MCP tool names.
  const result = {
    ...job,
    ...extra,
    downloaded_files: [file],
    next_step: `The clip is saved. ${STOP_STEP}`,
  };
  emit(ctx.out, result, (o) => {
    process.stdout.write(`${clipUrl}\n`);
    note(o, fmt.dim(o, savedLine(file)));
    const cost = costText(job);
    if (cost) note(o, `${label}: ${cost}.`);
    const billed = billedText(job);
    const waited = waitedText(job);
    if (billed || waited) {
      note(
        o,
        fmt.dim(
          o,
          [billed ? `Billed ${billed}.` : "", waited ? `Waited ${waited}.` : ""]
            .filter(Boolean)
            .join(" "),
        ),
      );
    }
  });
  stopHint(ctx);
}

export function registerRenderCommands(program: Command): void {
  const render = program
    .command("render")
    .description("Cloud render: render Blender scenes on a cloud GPU");

  render
    .command("blender <scene>")
    .description(
      "Render a packed .blend on your cloud GPU and download the MP4 (waits by default)",
    )
    .requiredOption(
      "--frames <range>",
      "frames to render, e.g. 1-240 (inclusive)",
    )
    .option(
      "--name <name>",
      "a label for the job, up to 80 characters (default: the scene's file name and the frames); status, wait, cancel and resume take it instead of the job id",
    )
    .option("--fps <n>", "output frame rate (default: the scene's own)")
    .option(
      "--chunk <n>",
      "frames per segment; finished segments survive a pause",
    )
    .option("--procs <n>", "Blender processes in parallel on the GPU, 1-4")
    .option(
      "--gpu <size>",
      "GPU size from `render prices`: full (96 GB, default, fastest); half (48 GB) or quarter (24 GB) cost less per frame when offered",
    )
    .option("--blender <version>", "Blender version: 5.2 (default) or 4.5")
    .option(
      "--out <path>",
      "directory or file for the clip (default media/renders/<job_id>.mp4)",
    )
    .option("--no-wait", "submit and print the job id without waiting")
    .action(async function (this: Command, scene: string) {
      const opts = this.opts<{
        frames: string;
        name?: string;
        fps?: string;
        chunk?: string;
        procs?: string;
        blender?: string;
        gpu?: string;
        out?: string;
        wait: boolean;
      }>();
      const frames = parseFrameRange(opts.frames);
      const given = jobNameOption(opts.name);
      const fps = positiveInt(opts.fps, "--fps");
      const chunk = positiveInt(opts.chunk, "--chunk");
      const procs = positiveInt(opts.procs, "--procs", 4);
      if (opts.gpu !== undefined && !GPU_SIZES.includes(opts.gpu)) {
        throw new UsageError(`--gpu must be ${GPU_SIZES.join(", ")}.`);
      }
      if (
        opts.blender !== undefined &&
        !BLENDER_VERSIONS.includes(opts.blender)
      ) {
        throw new UsageError(
          `--blender must be ${BLENDER_VERSIONS.join(" or ")}.`,
        );
      }
      const file = path.resolve(scene);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new UsageError(`Scene file not found: ${file}`);
      }
      if (path.extname(file).toLowerCase() !== ".blend") {
        throw new UsageError(`Expected a .blend file: ${file}`);
      }
      const size = fs.statSync(file).size;
      if (size === 0) throw new UsageError(`Scene file is empty: ${file}`);
      const name = given ?? defaultJobName(file, frames);
      const ctx = buildContext(this);

      const hashing = spinner(
        ctx.out,
        `Hashing ${path.basename(file)} (${formatBytes(size)})`,
      );
      let sha: string;
      try {
        sha = await fileSha256(file);
      } finally {
        hashing.stop();
      }

      const sceneUpload = await renderCall(
        ctx.client.callTool("cloud_render_upload_scene", { sha256: sha, size }),
      );
      let uploaded = false;
      if (sceneUpload?.exists === true) {
        note(
          ctx.out,
          fmt.dim(
            ctx.out,
            `Scene already uploaded (sha256 ${sha.slice(0, 12)}…).`,
          ),
        );
      } else {
        const uploadUrl = sceneUpload?.upload_url;
        if (typeof uploadUrl !== "string" || !uploadUrl) {
          throw new CliError(
            "cloud_render_upload_scene did not return an upload_url.",
          );
        }
        await uploadScene(ctx, uploadUrl, file, size);
        await renderCall(
          ctx.client.callTool("cloud_render_finalize_scene", { sha256: sha }),
        );
        uploaded = true;
      }

      const submitted = await renderCall(
        ctx.client.callTool(
          "cloud_render_submit",
          compact({
            scene_sha: sha,
            start: frames.start,
            end: frames.end,
            fps,
            chunk,
            procs,
            blender_version: opts.blender,
            gpu: opts.gpu,
            name,
          }),
        ),
      );
      const jobId = submitted?.job_id;
      if (typeof jobId !== "string" || !jobId) {
        throw new CliError("cloud_render_submit did not return a job_id.");
      }
      // Older servers do not keep names; say only what the server kept.
      const kept = typeof submitted?.name === "string" ? submitted.name : null;
      const label = jobLabel(jobId, kept);
      const rate = submitted?.credits_per_minute;
      note(
        ctx.out,
        `Submitted ${label}: frames ${frames.start}-${frames.end}${typeof submitted?.segments === "number" ? `, ${submitted.segments} segment${submitted.segments === 1 ? "" : "s"}` : ""}${typeof submitted?.gpu === "string" ? ` on ${submitted.gpu}` : ""}.`,
      );
      note(
        ctx.out,
        fmt.dim(
          ctx.out,
          `Waiting for a GPU is not billed. Once Google hands one over (usually within 10 minutes, longer at busy times), it bills ${typeof rate === "number" ? `${rate} credits per GPU-minute, ` : ""}per second.`,
        ),
      );
      const extra = { scene_sha: sha, uploaded, name: kept };
      if (!opts.wait) {
        const ref = kept ?? jobId;
        const result = {
          ...submitted,
          ...extra,
          next_step: `Wait for it with: videodraft render wait ${jobId}. ${WAIT_NOTE} ${STOP_STEP}`,
        };
        emit(ctx.out, result, (o) => {
          process.stdout.write(`${jobId}\n`);
          note(
            o,
            fmt.dim(
              o,
              `Wait for it with: videodraft render wait ${ref.includes(" ") ? `"${ref}"` : ref}`,
            ),
          );
        });
        return;
      }
      await waitAndDownload(ctx, jobId, opts.out, extra);
    });

  render
    .command("wait <job>")
    .description(
      "Wait for a render job (its id or name), then download its MP4",
    )
    .option(
      "--out <path>",
      "directory or file for the clip (default media/renders/<job_id>.mp4)",
    )
    .action(async function (this: Command, ref: string) {
      const ctx = buildContext(this);
      const jobId = await resolveJob(ctx, ref);
      await waitAndDownload(ctx, jobId, this.opts<{ out?: string }>().out);
    });

  render
    .command("status <job>")
    .description("Show a render job (its id or name) once, without waiting")
    .action(async function (this: Command, ref: string) {
      const ctx = buildContext(this);
      const jobId = await resolveJob(ctx, ref);
      const job = await renderCall(
        ctx.client.callTool("cloud_render_status", { job_id: jobId }),
      );
      emit(ctx.out, job, (o) => {
        const open = job?.status === "queued" || job?.status === "running";
        kv(o, [
          ["job", job?.job_id ?? jobId],
          ["name", job?.name],
          ["status", job?.status],
          ["now", open ? job?.message : undefined],
          ["gpu", job?.gpu],
          [
            "frames",
            job?.start !== undefined ? `${job.start}-${job.end}` : undefined,
          ],
          ["segments", segmentsText(job)],
          ["waited", waitedText(job)],
          ["cost", costText(job)],
          ["billed", billedText(job)],
          ["attempts", job?.attempts],
          ["error", job?.error],
          ["created", job?.created_at],
          ["finished", job?.finished_at],
          ["clip", job?.clip_url],
        ]);
        // The "now" line already says what a queued or running job is doing.
        if (job?.next_step && !open) note(o, fmt.dim(o, String(job.next_step)));
      });
    });

  render
    .command("list")
    .description("List recent render jobs: open ones first, then newest")
    .option("--limit <n>", "maximum jobs (default 20, at most 100)")
    .option("--name <name>", "only jobs with this name")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const opts = this.opts<{ limit?: string; name?: string }>();
      const limit = positiveInt(opts.limit, "--limit", 100);
      const name =
        opts.name === undefined
          ? undefined
          : opts.name.replace(/\s+/g, " ").trim() || undefined;
      const result = await renderCall(
        ctx.client.callTool("cloud_render_list", compact({ limit, name })),
      );
      let jobs: any[] = Array.isArray(result?.jobs) ? result.jobs : [];
      // An older server ignores the filter; apply it here too.
      if (name) {
        jobs = jobs.filter(
          (j) =>
            typeof j?.name === "string" &&
            j.name.toLowerCase() === name.toLowerCase(),
        );
      }
      const machines: any[] = Array.isArray(result?.machines)
        ? result.machines
        : [];
      emit(ctx.out, name ? { ...result, jobs } : result, (o) => {
        if (jobs.length === 0) {
          note(
            o,
            name ? `No render job is named "${name}".` : "No render jobs yet.",
          );
        } else {
          table(
            o,
            [
              "job_id",
              "name",
              "status",
              "gpu",
              "frames",
              "segments",
              "cost",
              "created",
            ],
            jobs.map((job) => [
              String(job?.job_id ?? ""),
              String(job?.name ?? ""),
              String(job?.status ?? ""),
              String(job?.gpu ?? ""),
              job?.start !== undefined ? `${job.start}-${job.end}` : "",
              segmentsText(job) ?? "",
              listCost(job),
              String(job?.created_at ?? "").slice(0, 19),
            ]),
          );
        }
        if (machines.length)
          note(o, fmt.dim(o, `Your machines now: ${machinesDoing(machines)}.`));
      });
    });

  render
    .command("cancel <job>")
    .description(
      "Cancel a queued or running render job, by id or name (finished segments are kept)",
    )
    .action(async function (this: Command, ref: string) {
      const ctx = buildContext(this);
      const jobId = await resolveJob(ctx, ref, "cancel");
      const result = await renderCall(
        ctx.client.callTool("cloud_render_cancel", { job_id: jobId }),
      );
      // What the job cost, so a cancel never leaves "did that cost me?" open. Best effort.
      let job: any = null;
      try {
        job = await ctx.client.callTool("cloud_render_status", {
          job_id: jobId,
        });
      } catch {
        job = null;
      }
      const cost = job?.cost;
      emit(
        ctx.out,
        cost
          ? { ...result, cost, wait_seconds: job?.wait_seconds ?? null }
          : result,
        (o) => {
          note(
            o,
            `${jobLabel(jobId, job?.name)}: ${result?.status ?? "cancel requested"}`,
          );
          const noFinalJobCharge =
            cost?.final === true &&
            cost?.credits === 0 &&
            cost?.gpu_seconds === 0;
          if (typeof cost?.credits === "number") {
            note(
              o,
              fmt.dim(
                o,
                noFinalJobCharge
                  ? "Job cost: 0 credits. Machine charges not assigned to a job appear in `videodraft render machine`."
                  : `Cost: ${costText(job)}.`,
              ),
            );
          }
          stopHint(ctx);
        },
      );
    });

  render
    .command("resume <job>")
    .description(
      "Queue a paused or failed render job again, by id or name (paid)",
    )
    .action(async function (this: Command, ref: string) {
      const ctx = buildContext(this);
      const jobId = await resolveJob(ctx, ref, "resume");
      const result = await renderCall(
        ctx.client.callTool("cloud_render_resume", { job_id: jobId }),
      );
      emit(ctx.out, result, (o) => {
        note(
          o,
          `${jobLabel(jobId, result?.name)}: ${result?.status ?? "queued"}`,
        );
        note(
          o,
          fmt.dim(
            o,
            `${WAIT_NOTE} Wait for it with: videodraft render wait ${jobId}`,
          ),
        );
      });
    });

  render
    .command("machine")
    .description(
      "Show your cloud GPU machines: what each is doing, what you pay now, and what you spent",
    )
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const machine = await renderCall(
        ctx.client.callTool("cloud_render_machine", {}),
      );
      emit(ctx.out, machine, (o) => {
        const machines: any[] = Array.isArray(machine?.machines)
          ? machine.machines
          : [];
        const phased = machines.some((m) => typeof m?.phase === "string");
        const now =
          typeof machine?.billing_credits_per_minute === "number"
            ? machine.billing_credits_per_minute
            : machine?.credits_per_minute;
        kv(o, [
          ["machines", machinesSummary(machines)],
          [
            "billing now",
            typeof now === "number"
              ? now > 0
                ? `${now} credits per minute`
                : "nothing"
              : undefined,
          ],
          [
            "spent (24h)",
            spentText(machine?.billed_24h) ??
              (typeof machine?.gpu_seconds_24h === "number"
                ? `${formatDuration(machine.gpu_seconds_24h)} of GPU time`
                : undefined),
          ],
          [
            "spent (all time)",
            spentText(machine?.billed_all_time) ??
              (typeof machine?.billed_seconds === "number"
                ? `${formatDuration(machine.billed_seconds)}${typeof machine?.billed_credits === "number" ? `, ${Number(machine.billed_credits.toFixed(2))} credits` : ""}`
                : undefined),
          ],
          [
            "balance",
            typeof machine?.balance === "number"
              ? `${machine.balance} credits`
              : undefined,
          ],
        ]);
        if (machines.length) {
          table(
            o,
            [
              "machine",
              "gpu",
              phased ? "status" : "state",
              "zone",
              "job",
              "credits/min",
            ],
            machines.map((m) => [
              String(m?.name ?? ""),
              String(m?.gpu ?? ""),
              phased
                ? (PHASE_WORDS[m?.phase] ?? String(m?.phase ?? ""))
                : String(m?.state ?? ""),
              String(m?.zone ?? ""),
              // The last job of an idle machine is history, not what it does now.
              !phased || m?.phase === "rendering"
                ? String(m?.job_id ?? "")
                : "",
              m?.billing === false
                ? "not billed"
                : m?.credits_per_minute === null ||
                    m?.credits_per_minute === undefined
                  ? ""
                  : String(m.credits_per_minute),
            ]),
          );
        }
        if (!machines.length || machines.some((m) => m?.billing === false)) {
          note(o, fmt.dim(o, WAIT_NOTE));
        }
      });
    });

  render
    .command("stop")
    .description(
      "Switch all your cloud GPU machines off now and settle the bill",
    )
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const result = await renderCall(
        ctx.client.callTool("cloud_render_stop", {}),
      );
      emit(ctx.out, result, (o) => {
        kv(o, [
          ["state", result?.state],
          [
            "spent (all time)",
            typeof result?.billed_seconds === "number"
              ? `${formatDuration(result.billed_seconds)}${typeof result?.billed_credits === "number" ? `, ${Number(result.billed_credits.toFixed(2))} credits` : ""}`
              : undefined,
          ],
        ]);
      });
    });

  render
    .command("prices")
    .description("Show the live Cloud render prices for each GPU size")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const prices = await renderCall(
        ctx.client.callTool("cloud_render_prices", {}),
      );
      emit(ctx.out, prices, (o) => {
        const gpus: any[] = Array.isArray(prices?.gpus) ? prices.gpus : [];
        if (gpus.length) {
          table(
            o,
            ["gpu", "name", "memory", "credits/min", "usd/hour"],
            gpus.map((g) => [
              String(g?.id ?? ""),
              String(g?.name ?? ""),
              typeof g?.vram_gb === "number" ? `${g.vram_gb} GB` : "",
              String(g?.credits_per_minute ?? ""),
              typeof g?.usd_per_hour === "number" ? `$${g.usd_per_hour}` : "",
            ]),
          );
          if (prices?.choosing) note(o, fmt.dim(o, String(prices.choosing)));
        } else {
          // Servers from before GPU sizes: one price.
          kv(o, [
            ["gpu", prices?.gpu],
            [
              "price",
              typeof prices?.credits_per_minute === "number"
                ? `${prices.credits_per_minute} credits per GPU-minute`
                : undefined,
            ],
          ]);
        }
        note(
          o,
          fmt.dim(
            o,
            `Billed per second while a machine is on; waiting for a GPU is not billed. A machine switches itself off ${IDLE_SHUTDOWN} after its last job.`,
          ),
        );
      });
    });
}

/** A job's cost in a list cell: final, so far, or nothing while it waits. */
function listCost(job: any): string {
  const credits = job?.cost?.credits;
  if (typeof credits !== "number") return "";
  if (
    job?.status === "queued" &&
    job?.machine?.phase === "waiting" &&
    credits === 0 &&
    job?.cost?.gpu_seconds === 0
  )
    return "not billed";
  return job?.cost?.final === true ? `${credits}` : `${credits} so far`;
}
