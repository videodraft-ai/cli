/**
 * Polling for async work: generation jobs (check_generation_status) and
 * video exports (check_export_status).
 */

import { AuthError, RpcError, TimeoutError, ToolError } from "./errors.js";
import type { VideoDraftClient } from "./rpc.js";

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /**
   * Adaptive backoff (default true): the effective interval grows as a job
   * runs long (base → ×2 after 60s → ×3 after 3min, capped at 15s) with ±10%
   * jitter so many concurrent CLIs don't poll in lockstep. Set false (the CLI
   * does this when --wait-interval is passed explicitly) for a fixed cadence.
   */
  adaptive?: boolean;
  /** Called every poll with the latest payload (drives spinners). */
  onTick?: (status: string, payload: any) => void;
}

/** Effective poll delay for a job that's been running `elapsedMs`. */
export function nextPollDelay(baseMs: number, elapsedMs: number, adaptive = true): number {
  if (!adaptive) return baseMs;
  const factor = elapsedMs >= 180_000 ? 3 : elapsedMs >= 60_000 ? 2 : 1;
  const scaled = Math.min(baseMs * factor, 15_000);
  const jitter = scaled * 0.1 * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(scaled + jitter));
}

const GENERATION_TERMINAL = new Set(["completed", "failed"]);
// "not_started" means no export row exists for this reference — no amount of
// polling can turn that into a finished render, so it is terminal too.
const EXPORT_TERMINAL = new Set(["finished", "failed", "not_started"]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface GenerationResult {
  status: string;
  outputUrls: string[];
  payload: any;
}

/** Extract output media URLs across the server's result shapes. */
export function extractOutputUrls(payload: any): string[] {
  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && /^https?:\/\//.test(value)) urls.push(value);
  };
  if (Array.isArray(payload?.outputUrls)) payload.outputUrls.forEach(push);
  if (Array.isArray(payload?.output_urls)) payload.output_urls.forEach(push);
  push(payload?.outputUrl);
  push(payload?.output_url);
  push(payload?.video_url);
  push(payload?.videoUrl);
  push(payload?.image_url);
  push(payload?.imageUrl);
  push(payload?.url);
  push(payload?.audio_url);
  push(payload?.audioUrl); // generate_music route shape
  push(payload?.speech_url); // generate_voiceover route shape
  push(payload?.public_url);
  return [...new Set(urls)];
}

export async function pollGeneration(
  client: VideoDraftClient,
  jobId: string,
  options: PollOptions = {},
): Promise<GenerationResult> {
  const intervalMs = options.intervalMs ?? 3_000;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  for (;;) {
    const payload: any = await client.callTool("check_generation_status", { job_id: jobId });
    const status = String(payload?.status ?? "unknown");
    options.onTick?.(status, payload);
    if (GENERATION_TERMINAL.has(status)) {
      return { status, outputUrls: extractOutputUrls(payload), payload };
    }
    if (Date.now() > deadline) {
      throw new TimeoutError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for job ${jobId} (last status: ${status}). ` +
          `It is still running server-side — check later with: videodraft status ${jobId}`,
      );
    }
    await sleep(nextPollDelay(intervalMs, Date.now() - startedAt, options.adaptive));
  }
}

/**
 * Poll MANY jobs from ONE process with ONE batched JSON-RPC request per tick.
 * This is the multi-CLI answer: N parallel generations should not mean N idle
 * Node processes and N req/tick — submit with --no-wait, then
 * `videodraft wait <id1> <id2> ...` (or the macOS app's sidecar calling this).
 * Per-job tool failures resolve that job as status "failed" without aborting
 * the rest.
 */
export async function pollGenerationsBatch(
  client: VideoDraftClient,
  jobIds: string[],
  options: PollOptions & { onJobDone?: (jobId: string, result: GenerationResult) => void } = {},
): Promise<Map<string, GenerationResult>> {
  const intervalMs = options.intervalMs ?? 3_000;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  const done = new Map<string, GenerationResult>();
  let pending = [...new Set(jobIds)];

  // Each batch item executes concurrently inside ONE server invocation —
  // chunk so a huge job list doesn't fan out unbounded parallel DB reads.
  const MAX_BATCH = 25;

  while (pending.length > 0) {
    const replies: Array<{ ok: boolean; result?: any; error?: string }> = [];
    for (let at = 0; at < pending.length; at += MAX_BATCH) {
      const chunk = pending.slice(at, at + MAX_BATCH);
      replies.push(
        ...(await client.callToolBatch(
          chunk.map((id) => ({ name: "check_generation_status", args: { job_id: id } })),
        )),
      );
    }
    const still: string[] = [];
    for (let i = 0; i < pending.length; i++) {
      const jobId = pending[i]!;
      const reply = replies[i]!;
      if (!reply.ok) {
        const result: GenerationResult = {
          status: "failed",
          outputUrls: [],
          payload: { error: reply.error },
        };
        done.set(jobId, result);
        options.onJobDone?.(jobId, result);
        continue;
      }
      const payload = reply.result;
      const status = String(payload?.status ?? "unknown");
      if (GENERATION_TERMINAL.has(status)) {
        const result: GenerationResult = { status, outputUrls: extractOutputUrls(payload), payload };
        done.set(jobId, result);
        options.onJobDone?.(jobId, result);
      } else {
        still.push(jobId);
      }
    }
    pending = still;
    options.onTick?.(`${done.size}/${jobIds.length} done`, { pending: pending.length });
    if (pending.length === 0) break;
    if (Date.now() > deadline) {
      throw new TimeoutError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s with ${pending.length} job(s) still running: ` +
          `${pending.join(", ")}. They continue server-side — resume with: videodraft wait ${pending.join(" ")}`,
      );
    }
    await sleep(nextPollDelay(intervalMs, Date.now() - startedAt, options.adaptive));
  }
  return done;
}

export async function pollExport(
  client: VideoDraftClient,
  ref: { exportId?: string; projectId?: string },
  options: PollOptions = {},
): Promise<{ status: string; videoUrl?: string; payload: any }> {
  const intervalMs = options.intervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 1_200_000;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  for (;;) {
    const payload: any = await client.callTool("check_export_status", {
      ...(ref.exportId ? { export_id: ref.exportId } : {}),
      ...(ref.projectId ? { project_id: ref.projectId } : {}),
    });
    const status = String(payload?.status ?? "unknown");
    options.onTick?.(status, payload);
    if (EXPORT_TERMINAL.has(status)) {
      return { status, videoUrl: payload?.video_url ?? payload?.videoUrl, payload };
    }
    if (Date.now() > deadline) {
      throw new TimeoutError(
        `Timed out waiting for export${ref.exportId ? ` ${ref.exportId}` : ""} (last status: ${status}).`,
      );
    }
    await sleep(nextPollDelay(intervalMs, Date.now() - startedAt, options.adaptive));
  }
}

// Cloud render statuses that end a wait. "paused" waits on the user, who must
// add credits and resume, so polling it further would never finish.
const RENDER_TERMINAL = new Set(["done", "failed", "cancelled", "paused"]);

export interface RenderPollOptions {
  /** Delay between status calls; default 10s. */
  intervalMs?: number;
  /** Give up after this long; default never, since renders can run for hours. */
  timeoutMs?: number;
  /** Failed status calls in a row tolerated before giving up; default 6. */
  maxConsecutiveErrors?: number;
  onTick?: (payload: any) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A status call that failed for a reason that can pass: the network, a 5xx
 * from either server, or the GPU service timing out. A long render should not
 * lose its waiter to one dropped request.
 */
function isTransientStatusError(error: unknown): boolean {
  if (error instanceof AuthError) return false;
  if (error instanceof ToolError) {
    const data = error.data as { http_status?: unknown; code?: unknown } | undefined;
    return (
      (typeof data?.http_status === "number" && data.http_status >= 500) ||
      data?.code === "cloud_render_timeout" ||
      data?.code === "cloud_render_unreachable"
    );
  }
  if (error instanceof RpcError) {
    return error.code === 0 || error.code === 429 || error.code >= 500;
  }
  // fetch() itself failed: offline, DNS, or our own request timeout.
  const name = (error as { name?: unknown } | null)?.name;
  return error instanceof TypeError || name === "TimeoutError" || name === "AbortError";
}

/** Poll a Cloud render job (cloud_render_status) until it stops moving. */
export async function pollRenderJob(
  client: VideoDraftClient,
  jobId: string,
  options: RenderPollOptions = {},
): Promise<any> {
  const intervalMs = options.intervalMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? Number.POSITIVE_INFINITY;
  const maxErrors = options.maxConsecutiveErrors ?? 6;
  const wait = options.sleep ?? sleep;
  const startedAt = Date.now();
  let errors = 0;
  for (;;) {
    let payload: any;
    try {
      payload = await client.callTool("cloud_render_status", { job_id: jobId });
      errors = 0;
    } catch (error) {
      errors++;
      if (!isTransientStatusError(error) || errors >= maxErrors) throw error;
      await wait(nextPollDelay(intervalMs, Date.now() - startedAt, false));
      continue;
    }
    options.onTick?.(payload);
    const status = String(payload?.status ?? "unknown");
    if (RENDER_TERMINAL.has(status)) return payload;
    if (Date.now() - startedAt > timeoutMs) {
      throw new TimeoutError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for render ${jobId} (last status: ${status}). ` +
          `It keeps rendering; check later with: videodraft render status ${jobId}`,
      );
    }
    await wait(nextPollDelay(intervalMs, Date.now() - startedAt, false));
  }
}

/** Poll many jobs concurrently (used by `shots --wait` batches). */
export async function pollGenerations(
  client: VideoDraftClient,
  jobIds: string[],
  options: PollOptions = {},
): Promise<GenerationResult[]> {
  return Promise.all(jobIds.map((id) => pollGeneration(client, id, options)));
}
