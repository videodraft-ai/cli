/**
 * `videodraft render ...`: Cloud render, Blender scenes on a cloud GPU.
 *
 *   render blender <scene.blend> --frames a-b
 *       hash, upload once (resumable chunks), submit, wait, download the MP4
 *   render status | wait | list | cancel | resume | machine | stop | prices
 *
 * Each user has one GPU machine. It starts on demand, renders their jobs in
 * order, and switches itself off 1 minute after the last one, billing per
 * second while it is on; `render stop` switches it off at once. The rate comes
 * from the server (`render prices`), never from this file.
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
const TOP_UP_HINT =
  "Check your balance with `videodraft credits` or top up at https://app.videodraft.ai/pricing";
const STOP_STEP = `The GPU bills until it switches itself off ${IDLE_SHUTDOWN} after its last job; run \`videodraft render stop\` once no more renders are needed.`;

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
  const estimate =
    typeof cost.estimated_total_credits === "number"
      ? `, about ${cost.estimated_total_credits} in total${typeof cost.estimated_minutes_left === "number" ? `, ${cost.estimated_minutes_left} min left` : ""}`
      : "";
  if (cost.final === true) return `${cost.credits} credits`;
  return `${cost.credits} credits so far${estimate}`;
}

function progressLine(jobId: string, job: any): string {
  const segments = segmentsText(job);
  return `${jobId}: ${job?.status ?? "unknown"}${segments ? ` (${segments})` : ""}`;
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
  const spin = spinner(ctx.out, `${jobId}: waiting`);
  let last = "";
  let job: any;
  try {
    job = await pollRenderJob(ctx.client, jobId, {
      intervalMs,
      timeoutMs,
      onTick: (payload) => {
        const line = progressLine(jobId, payload);
        const cost = costText(payload);
        spin.update(
          `${line}${cost ? ` · ${cost}` : ""} · ${formatDuration((Date.now() - startedAt) / 1000)}`,
        );
        if (line !== last) {
          last = line;
          logLine(ctx, line);
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
        fps?: string;
        chunk?: string;
        procs?: string;
        blender?: string;
        gpu?: string;
        out?: string;
        wait: boolean;
      }>();
      const frames = parseFrameRange(opts.frames);
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
          }),
        ),
      );
      const jobId = submitted?.job_id;
      if (typeof jobId !== "string" || !jobId) {
        throw new CliError("cloud_render_submit did not return a job_id.");
      }
      const rate = submitted?.credits_per_minute;
      note(
        ctx.out,
        `Submitted ${jobId}: frames ${frames.start}-${frames.end}${typeof submitted?.segments === "number" ? `, ${submitted.segments} segment${submitted.segments === 1 ? "" : "s"}` : ""}${typeof submitted?.gpu === "string" ? ` on ${submitted.gpu}` : ""}.`,
      );
      note(
        ctx.out,
        fmt.dim(
          ctx.out,
          `${typeof rate === "number" ? `Billed at ${rate} credits per GPU-minute,` : "Billed"} per second while the GPU is on.`,
        ),
      );
      const extra = { scene_sha: sha, uploaded };
      if (!opts.wait) {
        const result = {
          ...submitted,
          ...extra,
          next_step: `Wait for it with: videodraft render wait ${jobId}. ${STOP_STEP}`,
        };
        emit(ctx.out, result, (o) => {
          process.stdout.write(`${jobId}\n`);
          note(
            o,
            fmt.dim(o, `Wait for it with: videodraft render wait ${jobId}`),
          );
        });
        return;
      }
      await waitAndDownload(ctx, jobId, opts.out, extra);
    });

  render
    .command("wait <job_id>")
    .description("Wait for a render job, then download its MP4")
    .option(
      "--out <path>",
      "directory or file for the clip (default media/renders/<job_id>.mp4)",
    )
    .action(async function (this: Command, jobId: string) {
      const ctx = buildContext(this);
      await waitAndDownload(ctx, jobId, this.opts<{ out?: string }>().out);
    });

  render
    .command("status <job_id>")
    .description("Show a render job once (no waiting)")
    .action(async function (this: Command, jobId: string) {
      const ctx = buildContext(this);
      const job = await renderCall(
        ctx.client.callTool("cloud_render_status", { job_id: jobId }),
      );
      emit(ctx.out, job, (o) => {
        kv(o, [
          ["job", job?.job_id ?? jobId],
          ["status", job?.status],
          ["gpu", job?.gpu],
          [
            "frames",
            job?.start !== undefined ? `${job.start}-${job.end}` : undefined,
          ],
          ["segments", segmentsText(job)],
          ["cost", costText(job)],
          ["attempts", job?.attempts],
          ["error", job?.error],
          ["created", job?.created_at],
          ["finished", job?.finished_at],
          ["clip", job?.clip_url],
        ]);
        if (job?.next_step) note(o, fmt.dim(o, String(job.next_step)));
      });
    });

  render
    .command("list")
    .description("List recent render jobs, newest first")
    .option("--limit <n>", "maximum jobs (default 20, at most 100)")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const limit = positiveInt(
        this.opts<{ limit?: string }>().limit,
        "--limit",
        100,
      );
      const result = await renderCall(
        ctx.client.callTool("cloud_render_list", compact({ limit })),
      );
      const jobs: any[] = Array.isArray(result?.jobs) ? result.jobs : [];
      emit(ctx.out, result, (o) => {
        if (jobs.length === 0) {
          note(o, "No render jobs yet.");
          return;
        }
        table(
          o,
          ["job_id", "status", "frames", "segments", "created"],
          jobs.map((job) => [
            String(job?.job_id ?? ""),
            String(job?.status ?? ""),
            job?.start !== undefined ? `${job.start}-${job.end}` : "",
            segmentsText(job) ?? "",
            String(job?.created_at ?? "").slice(0, 19),
          ]),
        );
      });
    });

  render
    .command("cancel <job_id>")
    .description(
      "Cancel a queued or running render job (finished segments are kept)",
    )
    .action(async function (this: Command, jobId: string) {
      const ctx = buildContext(this);
      const result = await renderCall(
        ctx.client.callTool("cloud_render_cancel", { job_id: jobId }),
      );
      emit(ctx.out, result, (o) => {
        note(o, `${jobId}: ${result?.status ?? "cancel requested"}`);
        stopHint(ctx);
      });
    });

  render
    .command("resume <job_id>")
    .description("Queue a paused or failed render job again (paid)")
    .action(async function (this: Command, jobId: string) {
      const ctx = buildContext(this);
      const result = await renderCall(
        ctx.client.callTool("cloud_render_resume", { job_id: jobId }),
      );
      emit(ctx.out, result, (o) => {
        note(o, `${jobId}: ${result?.status ?? "queued"}`);
        note(
          o,
          fmt.dim(o, `Wait for it with: videodraft render wait ${jobId}`),
        );
      });
    });

  render
    .command("machine")
    .description(
      "Show your cloud GPU machines: state, billing and GPU time in the last 24 hours",
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
        kv(o, [
          ["state", machine?.state],
          ["machines", machines.length || undefined],
          [
            "burning",
            typeof machine?.credits_per_minute === "number" && machines.length
              ? `${machine.credits_per_minute} credits per minute`
              : undefined,
          ],
          [
            "billed",
            typeof machine?.billed_seconds === "number"
              ? `${formatDuration(machine.billed_seconds)}${typeof machine?.billed_credits === "number" ? `, ${Number(machine.billed_credits.toFixed(2))} credits` : ""}`
              : undefined,
          ],
          [
            "GPU time (24h)",
            typeof machine?.gpu_seconds_24h === "number"
              ? formatDuration(machine.gpu_seconds_24h)
              : undefined,
          ],
        ]);
        if (machines.length) {
          table(
            o,
            ["machine", "gpu", "state", "job", "credits/min"],
            machines.map((m) => [
              String(m?.name ?? ""),
              String(m?.gpu ?? ""),
              String(m?.state ?? ""),
              String(m?.job_id ?? ""),
              m?.credits_per_minute === null ||
              m?.credits_per_minute === undefined
                ? ""
                : String(m.credits_per_minute),
            ]),
          );
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
            "billed",
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
            `Billed per second while the machine is on; it switches itself off ${IDLE_SHUTDOWN} after its last job.`,
          ),
        );
      });
    });
}
