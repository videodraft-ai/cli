/**
 * `videodraft generate image|video|audio|voiceover|music|sound-effect|dialogue|voice-changer|dub`
 * and `videodraft upscale`.
 *
 * Conventions:
 *  - image/video are async server-side: submit → poll. We wait by default
 *    (spinner) and print/download outputs; --no-wait returns the job id.
 *  - --estimate prints the get_model_costs quote and exits without spending.
 *  - --ref accepts URLs or local file paths; local files are auto-uploaded
 *    via the create_media_upload flow before generating.
 */

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
  buildContext,
  collect,
  compact,
  sessionArg,
  type CommandContext,
} from "../cli/context.js";
import { emit, fmt, note, spinner } from "../cli/output.js";
import { pollGeneration, extractOutputUrls } from "../core/poll.js";
import { buildMediaDescriptors } from "../core/media.js";
import {
  downloadOutputs,
  savedLine,
  type DownloadedFile,
} from "../core/download.js";
import { uploadFile } from "../core/upload.js";
import {
  callAudioWithRetry,
  isRetryableAudioError,
} from "../core/audio-retry.js";
import { capture } from "../cli/telemetry.js";
import { CliError, EXIT, seedanceRealPersonRetryHint } from "../core/errors.js";

/** Any URI scheme (http(s), gs://, data:, …) passes through; a bare path is a local file. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const VIDEO_SOURCE_RE = /\.(mp4|mov|webm|m4v|gif)(?:[?#].*)?$/i;
const SEED_AUDIO_FORMATS = ["wav", "mp3", "pcm", "ogg_opus"] as const;
const SEED_AUDIO_SAMPLE_RATES = [
  8000, 16000, 24000, 32000, 44100, 48000,
] as const;
const SEED_AUDIO_PROMPT_MAX_CHARS = 2048;
const SEED_AUDIO_MAX_REFERENCES = 3;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeGeminiOmniResolutionOption(
  value: unknown,
): "360p" | "720p" | "1080p" | "4k" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "360p" ||
    normalized === "720p" ||
    normalized === "1080p" ||
    normalized === "4k"
    ? normalized
    : undefined;
}

function inferDubMediaType(
  source: string,
  explicit?: string,
): "audio" | "video" {
  if (explicit) {
    if (explicit === "audio" || explicit === "video") return explicit;
    throw new Error('--type must be "audio" or "video"');
  }
  return VIDEO_SOURCE_RE.test(source) ? "video" : "audio";
}

/**
 * Resolve reference inputs (images, videos, audio): pass URLs through, upload
 * local files to the CDN first. Unlike the raw MCP tool — which rejects local
 * video/audio paths — the CLI uploads them, so `--ref-video clip.mp4` works.
 */
export async function resolveRefs(
  ctx: CommandContext,
  refs: string[],
): Promise<string[]> {
  const resolved: string[] = [];
  for (const ref of refs) {
    if (URI_SCHEME.test(ref)) {
      resolved.push(ref);
      continue;
    }
    if (!fs.existsSync(ref)) {
      throw new Error(`"${ref}" is neither a URL nor an existing local file.`);
    }
    note(ctx.out, fmt.dim(ctx.out, `Uploading ${ref}…`));
    const uploaded = await uploadFile(ctx.client, ref);
    resolved.push(uploaded.url);
  }
  return resolved;
}

/** Parse repeatable `--segment "prompt text:seconds"` into multi_prompt entries. */
export function parseSegments(
  values: string[],
): Array<{ prompt: string; duration: number }> {
  return values.map((v) => {
    const i = v.lastIndexOf(":");
    if (i <= 0 || i === v.length - 1) {
      throw new CliError(
        `--segment expects "prompt:seconds", got: ${v}`,
        EXIT.USAGE,
      );
    }
    const prompt = v.slice(0, i).trim();
    const duration = Number(v.slice(i + 1));
    if (!prompt || !Number.isFinite(duration) || duration <= 0) {
      throw new CliError(
        `--segment "${v}" must be "<prompt>:<positive seconds>".`,
        EXIT.USAGE,
      );
    }
    return { prompt, duration };
  });
}

/**
 * Parse repeatable `--keyframe "<url|file>@<seconds>"` into FLUX 3 keyframes.
 * The URL comes first and the position last, split on the LAST `@` so URLs
 * containing one (signed links, userinfo) still parse.
 */
export function parseKeyframes(
  values: string[],
): Array<{ source: string; time_seconds: number }> {
  return values.map((value) => {
    const separator = value.lastIndexOf("@");
    if (separator <= 0 || separator === value.length - 1) {
      throw new CliError(
        `--keyframe expects "<url|file>@<seconds>", got: ${value}`,
        EXIT.USAGE,
      );
    }
    const source = value.slice(0, separator).trim();
    const timeSeconds = Number(value.slice(separator + 1));
    if (!source || !Number.isFinite(timeSeconds) || timeSeconds < 0) {
      throw new CliError(
        `--keyframe "${value}" must be "<url|file>@<seconds>" with a non-negative time.`,
        EXIT.USAGE,
      );
    }
    return { source, time_seconds: timeSeconds };
  });
}

export interface KlingElementArg {
  frontal_image_url?: string;
  reference_image_urls?: string[];
  video_url?: string;
  voice_id?: string;
}

/**
 * Parse repeatable Kling element JSON. `@path.json` is supported for scripts;
 * each value/file may contain one object or an array of objects.
 */
export function parseKlingElements(values: string[]): KlingElementArg[] {
  const parsed: KlingElementArg[] = [];
  for (const value of values) {
    let raw = value;
    if (value.startsWith("@")) {
      const path = value.slice(1);
      if (!path || !fs.existsSync(path)) {
        throw new CliError(
          `--element file does not exist: ${path || value}`,
          EXIT.USAGE,
        );
      }
      raw = fs.readFileSync(path, "utf8");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      throw new CliError(
        `--element must be valid JSON or @path.json: ${error instanceof Error ? error.message : String(error)}`,
        EXIT.USAGE,
      );
    }
    const entries = Array.isArray(decoded) ? decoded : [decoded];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new CliError(
          `--element entry ${index + 1} must be a JSON object.`,
          EXIT.USAGE,
        );
      }
      const item = entry as Record<string, unknown>;
      const frontal = item.frontal_image_url ?? item.frontalImageUrl;
      const refs = item.reference_image_urls ?? item.referenceImageUrls;
      const video = item.video_url ?? item.videoUrl;
      const voice = item.voice_id ?? item.voiceId;
      if (
        frontal !== undefined &&
        (typeof frontal !== "string" || !frontal.trim())
      ) {
        throw new CliError(
          "--element frontal_image_url must be a non-empty string.",
          EXIT.USAGE,
        );
      }
      if (
        refs !== undefined &&
        (!Array.isArray(refs) ||
          refs.some((ref) => typeof ref !== "string" || !ref.trim()))
      ) {
        throw new CliError(
          "--element reference_image_urls must be an array of non-empty strings.",
          EXIT.USAGE,
        );
      }
      if (video !== undefined && (typeof video !== "string" || !video.trim())) {
        throw new CliError(
          "--element video_url must be a non-empty string.",
          EXIT.USAGE,
        );
      }
      if (
        voice !== undefined &&
        (typeof voice !== "string" ||
          !voice.trim() ||
          voice.trim().length > 512)
      ) {
        throw new CliError(
          "--element voice_id must be a non-empty string no longer than 512 characters. Do not coerce numeric-looking IDs to numbers.",
          EXIT.USAGE,
        );
      }
      parsed.push({
        ...(frontal ? { frontal_image_url: frontal.trim() } : {}),
        ...(refs
          ? {
              reference_image_urls: (refs as string[]).map((ref) => ref.trim()),
            }
          : {}),
        ...(video ? { video_url: video.trim() } : {}),
        ...(voice ? { voice_id: voice.trim() } : {}),
      });
    }
  }
  return parsed;
}

export async function resolveKlingElements(
  ctx: CommandContext,
  elements: KlingElementArg[],
): Promise<KlingElementArg[]> {
  return Promise.all(
    elements.map(async (element) => ({
      ...(element.frontal_image_url
        ? {
            frontal_image_url: (
              await resolveRefs(ctx, [element.frontal_image_url])
            )[0],
          }
        : {}),
      ...(element.reference_image_urls
        ? {
            reference_image_urls: await resolveRefs(
              ctx,
              element.reference_image_urls,
            ),
          }
        : {}),
      ...(element.video_url
        ? { video_url: (await resolveRefs(ctx, [element.video_url]))[0] }
        : {}),
      ...(element.voice_id ? { voice_id: element.voice_id } : {}),
    })),
  );
}

function optionalPositiveNumber(
  value: unknown,
  label: string,
  integer = false,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    (integer && !Number.isInteger(parsed))
  ) {
    throw new CliError(
      `${label} must be a positive${integer ? " whole" : ""} number.`,
      EXIT.USAGE,
    );
  }
  return parsed;
}

/**
 * Widest combined reference-video window any model accepts, used only to parse
 * the flag before the model is known. `refVideoSecondsWindow` holds the real
 * per-model limits.
 */
const REF_VIDEO_SECONDS_MAX = 30;

/**
 * Combined reference-video seconds a model accepts, or null when this CLI
 * does not expose a duration window for it. Pricing still decides separately
 * whether those input seconds are billable.
 */
function refVideoSecondsWindow(model: string | undefined): number | null {
  switch (model) {
    case "seedance-2.5":
      return 30;
    case "seedance-2":
    case "minimax-h3":
    case "wan-3.0":
      return 15;
    default:
      return null;
  }
}

function optionalRangedNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
  integer = false,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < min ||
    parsed > max ||
    (integer && !Number.isInteger(parsed))
  ) {
    throw new CliError(
      `${label} must be ${integer ? "a whole number " : ""}from ${min} to ${max}.`,
      EXIT.USAGE,
    );
  }
  return parsed;
}

function optionalSeed(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliError("--seed must be a safe integer.", EXIT.USAGE);
  }
  return parsed;
}

function optionalBooleanChoice(
  value: unknown,
  label: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(normalized)) return true;
  if (["false", "off", "no", "0"].includes(normalized)) return false;
  throw new CliError(
    `${label} must be true or false (on/off and yes/no are also accepted).`,
    EXIT.USAGE,
  );
}

function estimateVideoModel(
  opts: Record<string, any>,
  duration: number | undefined,
): string {
  if (opts.model) return opts.model;
  if (
    opts.previousInteractionId ||
    opts.videoTask ||
    opts.extend ||
    (opts.refVideoDuration?.length ?? 0) > 0
  ) {
    return "gemini-omni-1.1-flash";
  }
  const referenceImageCount = Array.isArray(opts.ref) ? opts.ref.length : 0;
  const referenceVideoCount = Array.isArray(opts.refVideo)
    ? opts.refVideo.length
    : 0;
  const referenceAudioCount = Array.isArray(opts.refAudio)
    ? opts.refAudio.length
    : 0;
  const wan3Task =
    opts.autoDuration === true ||
    opts.promptExpansion !== undefined ||
    opts.thinking === true ||
    Boolean(opts.fileUrl) ||
    Boolean(opts.webUrl);
  const h3MaxTask =
    opts.promptExpansionMode !== undefined ||
    opts.safetyChecker !== undefined;
  if (h3MaxTask) return "minimax-h3-max";
  if (wan3Task) return "wan-3.0";
  // Anything past Seedance 2.0's ceilings (15s, 9 image / 3 video / 3 audio
  // refs) needs 2.5, which reaches 30s and 30/10/10 references.
  const seedance25Task =
    (duration !== undefined && duration > 15) ||
    referenceImageCount > 9 ||
    referenceVideoCount > 3 ||
    referenceAudioCount > 3;
  if (seedance25Task) return "seedance-2.5";

  const seedanceTask =
    (duration !== undefined && duration > 10) ||
    referenceVideoCount > 3 ||
    referenceAudioCount > 0 ||
    opts.quality === "mini" ||
    opts.quality === "standard";
  if (seedanceTask) return "seedance-2";

  const veoTask =
    opts.audio === false ||
    opts.quality === "fast" ||
    opts.quality === "quality" ||
    (typeof opts.resolution === "string" &&
      !normalizeGeminiOmniResolutionOption(opts.resolution));
  if (veoTask) {
    return referenceVideoCount > 0 ? "seedance-2" : "google-veo3.1";
  }
  return "gemini-omni-1.1-flash";
}

async function printEstimate(
  ctx: CommandContext,
  params: {
    model?: string;
    type: "image" | "video" | "audio";
    duration?: number;
    autoDuration?: boolean;
    resolution?: string;
    quality?: string;
    renderingSpeed?: string;
    audio?: boolean;
    num?: number;
    referenceImageCount?: number;
    referenceVideoDurationSeconds?: number;
    voiceControl?: boolean;
    allowRealPeople?: boolean;
  },
): Promise<void> {
  const estimate = await ctx.client.callTool(
    "get_model_costs",
    compact({
      model_id: params.model,
      type: params.type,
      duration_seconds: params.duration,
      auto_duration: params.autoDuration ? true : undefined,
      resolution: params.resolution,
      quality: params.quality,
      rendering_speed: params.renderingSpeed,
      generate_audio: params.audio,
      reference_image_count: params.referenceImageCount,
      reference_video_duration_seconds: params.referenceVideoDurationSeconds,
      voice_control: params.voiceControl ? true : undefined,
      allow_real_people: params.allowRealPeople ? true : undefined,
      num_images: params.num,
    }),
  );
  emit(ctx.out, { estimate, note: "No credits were spent (--estimate)." });
}

export interface SubmitWaitOptions {
  wait: boolean;
  download?: string;
  label: string;
}

/** Shared submit → poll → download tail for async generations. */
export async function handleAsyncJob(
  ctx: CommandContext,
  submitted: any,
  options: SubmitWaitOptions,
): Promise<void> {
  const jobId: string | undefined = submitted?.job_id ?? submitted?.jobId;
  if (!jobId || !options.wait) {
    emit(ctx.out, submitted, (o) => {
      note(o, `Submitted${jobId ? ` — job ${jobId}` : ""}.`);
      if (jobId) note(o, fmt.dim(o, `Poll with: videodraft status ${jobId}`));
    });
    return;
  }

  const spin = spinner(ctx.out, `${options.label} (job ${jobId})…`);
  try {
    const result = await pollGeneration(ctx.client, jobId, {
      intervalMs: ctx.intervalMs,
      timeoutMs: ctx.timeoutMs,
      adaptive: ctx.adaptive,
      onTick: (status) =>
        spin.update(`${options.label}: ${status} (job ${jobId})`),
    });
    spin.stop();

    if (result.status === "failed") {
      emit(ctx.out, { job_id: jobId, ...result.payload }, (o) => {
        note(
          o,
          fmt.red(
            o,
            `Job ${jobId} failed: ${result.payload?.error ?? "unknown error"}`,
          ),
        );
        const retryHint = seedanceRealPersonRetryHint(result.payload);
        if (retryHint) note(o, fmt.dim(o, retryHint));
      });
      process.exitCode = 1;
      return;
    }

    let downloaded: DownloadedFile[] | undefined;
    if (options.download && result.outputUrls.length > 0) {
      downloaded = await downloadOutputs(result.outputUrls, options.download, {
        job_id: jobId,
      });
    }
    const media = buildMediaDescriptors(
      result.outputUrls,
      result.payload?.type,
    );
    const interactionId =
      result.payload?.interaction_id ??
      submitted?.geminiOmniInteractionId ??
      submitted?.interaction_id;
    emit(
      ctx.out,
      {
        job_id: jobId,
        status: result.status,
        outputs: result.outputUrls,
        outputMetadata: result.payload?.outputMetadata,
        ...(interactionId ? { interaction_id: interactionId } : {}),
        ...(result.payload?.video_task
          ? { video_task: result.payload.video_task }
          : {}),
        ...(result.payload?.cumulative_duration_seconds !== undefined
          ? {
              cumulative_duration_seconds:
                result.payload.cumulative_duration_seconds,
            }
          : {}),
        ...(result.payload?.continuation_available !== undefined
          ? {
              continuation_available:
                result.payload.continuation_available,
            }
          : {}),
        ...(result.payload?.continuation_unavailable_reason
          ? {
              continuation_unavailable_reason:
                result.payload.continuation_unavailable_reason,
            }
          : {}),
        downloaded_files: downloaded,
        output_media: media,
      },
      (o) => {
        note(o, fmt.green(o, `Completed — job ${jobId}`));
        if (
          interactionId &&
          result.payload?.continuation_available !== false
        ) {
          note(
            o,
            fmt.dim(
              o,
              `Interaction ID: ${interactionId} (use with --previous-interaction-id)`,
            ),
          );
        } else if (
          interactionId &&
          result.payload?.continuation_available === false
        ) {
          note(
            o,
            fmt.dim(
              o,
              `Interaction ID: ${interactionId} (continuation unavailable${result.payload?.continuation_unavailable_reason ? `: ${result.payload.continuation_unavailable_reason}` : ""})`,
            ),
          );
        }
        for (const url of result.outputUrls) process.stdout.write(`${url}\n`);
        for (const file of downloaded ?? [])
          note(o, fmt.dim(o, savedLine(file)));
      },
    );
  } catch (err) {
    spin.stop();
    throw err;
  }
}

export function registerGenerateCommands(program: Command): void {
  const generate = program
    .command("generate")
    .description("Generate images, video and audio");

  generate
    .command("image <prompt...>")
    .description("Generate an image (async; waits by default)")
    .option(
      "--model <id|name>",
      "image model id or display name (default nano-banana-2); run `videodraft models image`",
    )
    .option("--ar <ratio>", 'aspect ratio, e.g. "16:9"')
    .option("--resolution <res>", 'e.g. "1K", "2K", "4K"')
    .option("--quality <tier>", "model-specific quality tier")
    .option(
      "--rendering-speed <tier>",
      'Ideogram speed/cost tier, e.g. V4 "Turbo"/"Balanced"/"Quality"',
    )
    .option("--num <n>", "variations of this prompt in one call (1-4)")
    .option(
      "--seed <n>",
      "seed (supported models only, e.g. Flux, Ideogram V4)",
    )
    .option(
      "--ref <url|file>",
      "reference image (repeatable; local files are uploaded)",
      collect,
      [],
    )
    .option(
      "--video-ref <url|file>",
      "video reference, nano-banana-2 only (http(s)/gs:///YouTube, or local file)",
    )
    .option("--style <id>", "style preset id")
    .option("--project <id>", "attach to a project")
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option(
      "--scene <n>",
      "0-based scene index (with --project: writes onto that shot)",
    )
    .option("--shot <n>", "0-based shot index")
    .option(
      "--download <path>",
      "download outputs (template: {job_id} {index} {ext})",
    )
    .option("--no-wait", "submit and return the job id immediately")
    .option("--estimate", "print the cost estimate and exit (spends nothing)")
    .action(async function (this: Command, promptWords: string[]) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const prompt = promptWords.join(" ");

      if (opts.estimate) {
        await printEstimate(ctx, {
          // Cost lookup needs a concrete model. Keep runtime generation
          // model-less so the server can still make its task-aware choice.
          model: opts.model ?? "nano-banana-2",
          type: "image",
          resolution: opts.resolution,
          quality: opts.quality,
          renderingSpeed: opts.renderingSpeed,
          num: opts.num ? Number(opts.num) : undefined,
          // grok-imagine-2.0 bills 1 credit per reference image on top of the
          // resolution x quality matrix. Without this the quote omits the
          // surcharge entirely (two 2K-medium outputs with 3 refs quoted 16,
          // deducted 22). Only sent when refs exist, so a plain estimate call
          // keeps its existing shape.
          ...(Array.isArray(opts.ref) && opts.ref.length > 0
            ? { referenceImageCount: opts.ref.length }
            : {}),
        });
        return;
      }

      const [refs, videoRef] = await Promise.all([
        resolveRefs(ctx, opts.ref ?? []),
        opts.videoRef
          ? resolveRefs(ctx, [opts.videoRef]).then((r) => r[0])
          : undefined,
      ]);
      capture("cli_generate", {
        kind: "image",
        model: opts.model ?? "default",
        wait: opts.wait !== false,
      });
      const submitted = await ctx.client.callTool(
        "generate_image",
        compact({
          prompt,
          model: opts.model,
          aspect_ratio: opts.ar,
          resolution: opts.resolution,
          quality: opts.quality,
          rendering_speed: opts.renderingSpeed,
          num_images: opts.num ? Number(opts.num) : undefined,
          seed: opts.seed ? Number(opts.seed) : undefined,
          reference_images: refs.length > 0 ? refs : undefined,
          video_url: videoRef,
          style: opts.style,
          project_id: opts.project,
          session_id: sessionArg(this, opts),
          scene_index:
            opts.scene !== undefined ? Number(opts.scene) : undefined,
          shot_index: opts.shot !== undefined ? Number(opts.shot) : undefined,
        }),
      );
      await handleAsyncJob(ctx, submitted, {
        wait: opts.wait !== false,
        download: opts.download,
        label: "Generating image",
      });
    });

  generate
    .command("video [prompt...]")
    .description(
      "Generate a video clip (async; per-second pricing, see --estimate)",
    )
    .option(
      "--model <id>",
      "video model id (task-aware when omitted; Grok 1.5 supports text, first frame, or 1-7 image refs)",
    )
    .option("--ar <ratio>", 'aspect ratio, e.g. "16:9", "9:16"')
    .option("--duration <seconds>", "clip duration in seconds")
    .option(
      "--auto-duration",
      "Wan 3.0 only: provider selects 2-30s; reserves 30s and reconciles unused credits",
    )
    .option("--resolution <res>", 'e.g. "360p", "720p", "1080p", "2K", "4K"')
    .option(
      "--quality <tier>",
      'e.g. "mini", "fast", "standard", "quality", "pro"',
    )
    .option("--audio", "generate native model audio")
    .option("--no-audio", "disable native model audio")
    .option(
      "--allow-real-people",
      "Seedance 2.x only: use initially when supplied start/end frames or image/video references visibly contain a real identifiable person. Keep the Byteplus default for text-only, non-person, anime, or clearly synthetic/stylized inputs. Otherwise retry once only after SEEDANCE_REAL_PERSON_OPT_IN_REQUIRED. This permits Fal fallback at its higher tier-specific rate. Use --estimate first.",
    )
    .option("--start-image <url|file>", "start frame (image-to-video)")
    .option("--end-image <url|file>", "end frame (supported models only)")
    .option("--ref <url|file>", "reference image (repeatable)", collect, [])
    .option(
      "--source-video <url|file>",
      "Gemini Omni 1.1 Flash source video for edit (up to 10s) or extend (1-30s); edit and extend accept exactly one input video, so --ref-video cannot accompany it (local file uploaded)",
    )
    .option(
      "--ref-video <url|file>",
      "creative reference video (repeatable; Gemini Omni 1.1 Flash accepts up to 3 of <=3s each; one ref with no --source-video remains a legacy source edit; local files uploaded)",
      collect,
      [],
    )
    .option(
      "--ref-video-duration <seconds>",
      "Gemini Omni 1.1 Flash: measured duration matching each creative --ref-video by index (repeatable; optional because the server measures public videos)",
      collect,
      [],
    )
    .option(
      "--ref-audio <url|file>",
      "reference audio (repeatable; Wan 3.0, MiniMax H3, Seedance 2, or Seedance 2.5; local files uploaded)",
      collect,
      [],
    )
    .option(
      "--element <json|@file>",
      'Kling structured element, e.g. \'{"video_url":"actor.mp4","voice_id":"123..."}\' (repeatable; object or array JSON)',
      collect,
      [],
    )
    .option(
      "--voice-id <id>",
      "Kling 2.6 Pro custom voice ID (repeatable, max 2; cite as <<<voice_1>>> / <<<voice_2>>>)",
      collect,
      [],
    )
    .option(
      "--ref-video-seconds <seconds>",
      "combined reference-video duration for an exact --estimate (Seedance 2.x bills input seconds; MiniMax H3 and Wan 3.0 do not). Max 30s on Seedance 2.5, 15s elsewhere",
    )
    .option(
      "--keyframe <url|file@seconds>",
      "FLUX 3 keyframe pinned to a moment, e.g. shot.png@2.5 (repeatable, max 10; local files uploaded)",
      collect,
      [],
    )
    .option(
      "--segment <prompt:seconds>",
      "multi-prompt segment (repeatable; Kling 3.0 / 3.0 Turbo / O3)",
      collect,
      [],
    )
    .option("--negative <text>", "negative prompt (Kling/Luma; not Wan 3.0)")
    .option("--camera-fixed", "Seedance 1.5 Pro: lock camera motion")
    .option(
      "--prompt-expansion <true|false>",
      "Wan 3.0 only: enable or disable prompt expansion (default true)",
    )
    .option(
      "--prompt-expansion-mode <mode>",
      "MiniMax H3 Max only: disabled, balanced (default), or quality",
    )
    .option(
      "--safety-checker <true|false>",
      "MiniMax H3 Max only: enable or disable provider safety checking (default true)",
    )
    .option(
      "--thinking",
      "Wan 3.0 only: enable provider thinking; required with --file-url/--web-url",
    )
    .option(
      "--file-url <url>",
      "Wan 3.0 reference mode: public document URL (requires --thinking)",
    )
    .option(
      "--web-url <url>",
      "Wan 3.0 reference mode: public webpage URL (requires --thinking)",
    )
    .option(
      "--previous-interaction-id <id>",
      "Gemini Omni 1.1 Flash: continue an earlier generation; with --extend, append 3-10s up to 40s total. The prior output becomes the source, so it must be <=30s to extend or <=10s to edit, --ref-video cannot accompany it, and new dialogue needs a silent source (unsupported with Fal BYOK)",
    )
    .option(
      "--video-task <task>",
      "Gemini Omni 1.1 Flash mode: generate, edit, or extend",
    )
    .option(
      "--extend",
      "Gemini Omni 1.1 Flash: append an explicit 3-10s to a 1-30s uploaded source or prior interaction, up to 40s total; shorthand for --video-task extend",
    )
    .option("--seed <n>", "seed")
    .option("--project <id>", "attach to a project")
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--scene <n>", "0-based scene index")
    .option("--shot <n>", "0-based shot index")
    .option(
      "--download <path>",
      "download outputs (template: {job_id} {index} {ext})",
    )
    .option("--no-wait", "submit and return the job id immediately")
    .option("--estimate", "print the cost estimate and exit (spends nothing)")
    .action(async function (this: Command, promptWords: string[] = []) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      if (["wan-2.7", "wan27", "wan-2.7-ref-edit"].includes(opts.model)) {
        throw new CliError(
          "Wan 2.7 is retired from VideoDraft generation. Use --model wan-3.0.",
          EXIT.USAGE,
        );
      }
      // prompt is OPTIONAL: Kling 3.0 / 3.0 Turbo / O3 allow multi-prompt-only
      // calls, and Kling 3.0 Turbo allows image-to-video with no prompt.
      const prompt = promptWords.join(" ").trim();
      const duration = optionalPositiveNumber(opts.duration, "--duration");
      const promptExpansion = optionalBooleanChoice(
        opts.promptExpansion,
        "--prompt-expansion",
      );
      const safetyChecker = optionalBooleanChoice(
        opts.safetyChecker,
        "--safety-checker",
      );
      const promptExpansionMode =
        opts.promptExpansionMode === undefined
          ? undefined
          : String(opts.promptExpansionMode).trim().toLowerCase();
      if (
        promptExpansionMode !== undefined &&
        !["disabled", "balanced", "quality"].includes(promptExpansionMode)
      ) {
        throw new CliError(
          "--prompt-expansion-mode must be disabled, balanced, or quality.",
          EXIT.USAGE,
        );
      }
      // Parsed against the WIDEST window any model accepts. The real limit is
      // per model — Seedance 2.5 takes 30 combined reference seconds where 2.0
      // takes 15 — and the model is not resolved until the estimate
      // branch below, which is where the exact limit is enforced. A global 15
      // here rejected perfectly valid 2.5 commands before they were ever
      // priced.
      const refVideoSeconds = optionalRangedNumber(
        opts.refVideoSeconds,
        "--ref-video-seconds",
        0,
        REF_VIDEO_SECONDS_MAX,
      );
      const referenceVideoDurations = (opts.refVideoDuration ?? []).map(
        (raw: string) => Number(raw),
      );
      if (
        referenceVideoDurations.some(
          (seconds: number) =>
            !Number.isFinite(seconds) || seconds <= 0 || seconds > 3,
        )
      ) {
        throw new CliError(
          "Each --ref-video-duration must be greater than 0 and at most 3 seconds.",
          EXIT.USAGE,
        );
      }
      const seed = optionalSeed(opts.seed);
      const rawElements = parseKlingElements(opts.element ?? []);
      const voiceIds = (opts.voiceId ?? []) as string[];
      const segments = parseSegments(opts.segment ?? []);
      if (segments.length > 0 && prompt) {
        throw new CliError(
          "A main prompt cannot be combined with --segment. Use one or more --segment values by themselves.",
          EXIT.USAGE,
        );
      }
      if (segments.length > 0 && duration !== undefined) {
        throw new CliError(
          "--duration cannot be combined with --segment because segment durations determine the clip length.",
          EXIT.USAGE,
        );
      }
      if (
        segments.length > 6 ||
        segments.some(
          (segment) =>
            !Number.isInteger(segment.duration) ||
            segment.duration < 1 ||
            segment.duration > 15,
        )
      ) {
        throw new CliError(
          "--segment supports 1-6 entries with whole-second durations from 1 to 15.",
          EXIT.USAGE,
        );
      }
      const segmentDuration = segments.reduce(
        (sum, segment) => sum + segment.duration,
        0,
      );
      if (
        segments.length > 0 &&
        (segmentDuration < 3 || segmentDuration > 15)
      ) {
        throw new CliError(
          "The total --segment duration must be between 3 and 15 seconds.",
          EXIT.USAGE,
        );
      }
      if (rawElements.length > 0 && voiceIds.length > 0) {
        throw new CliError(
          "Do not combine --element with top-level --voice-id. Kling V3/O3 bind voice_id inside the matching element; Kling 2.6 uses --voice-id.",
          EXIT.USAGE,
        );
      }
      const hasWan3OnlyControls =
        opts.autoDuration === true ||
        promptExpansion !== undefined ||
        opts.thinking === true ||
        Boolean(opts.fileUrl) ||
        Boolean(opts.webUrl);
      const hasH3MaxOnlyControls =
        promptExpansionMode !== undefined || safetyChecker !== undefined;
      const hasGeminiOmniOnlyControls =
        Boolean(opts.sourceVideo) ||
        Boolean(opts.previousInteractionId) ||
        Boolean(opts.videoTask) ||
        opts.extend === true ||
        referenceVideoDurations.length > 0;
      if (!opts.model && hasGeminiOmniOnlyControls) {
        opts.model = "gemini-omni-1.1-flash";
      } else if (!opts.model && hasH3MaxOnlyControls) {
        opts.model = "minimax-h3-max";
      } else if (!opts.model && hasWan3OnlyControls) {
        opts.model = "wan-3.0";
      } else if (!opts.model && voiceIds.length > 0) {
        opts.model = "kling-2.6-pro";
      } else if (!opts.model && rawElements.length > 0) {
        opts.model = opts.startImage ? "kling-3.0" : "kling-o3";
      } else if (!opts.model && segments.length > 0) {
        opts.model = "kling-3.0";
      }
      if (
        ["h3-max", "h3max", "minimax_h3_max"].includes(
          String(opts.model || ""),
        )
      ) {
        opts.model = "minimax-h3-max";
      }
      if (
        (!opts.model || opts.model === "gemini-omni-1.1-flash") &&
        opts.resolution
      ) {
        const normalizedResolution = normalizeGeminiOmniResolutionOption(
          opts.resolution,
        );
        if (normalizedResolution) opts.resolution = normalizedResolution;
      }
      if (
        seed !== undefined &&
        seed < 0 &&
        opts.model !== "minimax-h3-max"
      ) {
        throw new CliError(
          "--seed must be non-negative unless --model minimax-h3-max is selected.",
          EXIT.USAGE,
        );
      }
      if (
        segments.length > 0 &&
        !["kling-3.0", "kling-v3-turbo", "kling-o3"].includes(opts.model)
      ) {
        throw new CliError(
          "--segment is supported only by kling-3.0, kling-v3-turbo, and kling-o3.",
          EXIT.USAGE,
        );
      }

      let geminiVideoTask = opts.videoTask
        ? String(opts.videoTask).trim().toLowerCase()
        : undefined;
      if (
        geminiVideoTask !== undefined &&
        !["generate", "edit", "extend"].includes(geminiVideoTask)
      ) {
        throw new CliError(
          "--video-task must be generate, edit, or extend.",
          EXIT.USAGE,
        );
      }
      if (opts.extend === true) {
        if (geminiVideoTask && geminiVideoTask !== "extend") {
          throw new CliError(
            "--extend conflicts with a non-extend --video-task.",
            EXIT.USAGE,
          );
        }
        geminiVideoTask = "extend";
      }
      if (opts.previousInteractionId) {
        if (geminiVideoTask === "generate") {
          throw new CliError(
            "--previous-interaction-id supports --video-task edit or extend, not generate.",
            EXIT.USAGE,
          );
        }
        geminiVideoTask = geminiVideoTask || "edit";
      }
      if (
        hasGeminiOmniOnlyControls &&
        opts.model !== "gemini-omni-1.1-flash"
      ) {
        throw new CliError(
          "--source-video, --previous-interaction-id, --video-task, --extend, and --ref-video-duration are supported only by --model gemini-omni-1.1-flash.",
          EXIT.USAGE,
        );
      }

      if (opts.model === "gemini-omni-1.1-flash") {
        const imageCount = Array.isArray(opts.ref) ? opts.ref.length : 0;
        const videoCount = Array.isArray(opts.refVideo)
          ? opts.refVideo.length
          : 0;
        const frameInputCount =
          Number(Boolean(opts.startImage)) + Number(Boolean(opts.endImage));
        const usesLegacyReferenceAsSource =
          !opts.sourceVideo &&
          !opts.previousInteractionId &&
          geminiVideoTask !== "generate" &&
          videoCount === 1;
        const maxReferenceImages = 10 - frameInputCount;
        if (
          duration !== undefined &&
          (!Number.isInteger(duration) || duration < 3 || duration > 10)
        ) {
          throw new CliError(
            "gemini-omni-1.1-flash --duration must be a whole second from 3 to 10.",
            EXIT.USAGE,
          );
        }
        if (opts.endImage && !opts.startImage) {
          throw new CliError(
            "gemini-omni-1.1-flash --end-image requires --start-image.",
            EXIT.USAGE,
          );
        }
        if (imageCount > maxReferenceImages) {
          throw new CliError(
            `gemini-omni-1.1-flash accepts at most ${maxReferenceImages} --ref images after counting --start-image and --end-image toward the 10-image total.`,
            EXIT.USAGE,
          );
        }
        if (videoCount > 3) {
          throw new CliError(
            "gemini-omni-1.1-flash accepts at most 3 --ref-video inputs.",
            EXIT.USAGE,
          );
        }
        if (opts.previousInteractionId && opts.sourceVideo) {
          throw new CliError(
            "--previous-interaction-id cannot be combined with --source-video.",
            EXIT.USAGE,
          );
        }
        // Google accepts exactly one input video for edit and extend, so a
        // creative reference cannot ride alongside the source. A continuation
        // resolves to the prior output and is a source too. The legacy
        // single-ref-as-source form is untouched: it has no separate source.
        if (
          videoCount > 0 &&
          (opts.sourceVideo || opts.previousInteractionId) &&
          geminiVideoTask !== "generate"
        ) {
          throw new CliError(
            `gemini-omni-1.1-flash accepts exactly one input video for an ${geminiVideoTask ?? "edit"} task, so --ref-video cannot accompany --source-video or --previous-interaction-id. Drop the references, or use --video-task generate to guide a new clip with them.`,
            EXIT.USAGE,
          );
        }
        if (opts.sourceVideo && geminiVideoTask === "generate") {
          throw new CliError(
            "--source-video supports --video-task edit or extend, not generate.",
            EXIT.USAGE,
          );
        }
        if (
          videoCount > 1 &&
          !opts.sourceVideo &&
          !opts.previousInteractionId &&
          geminiVideoTask !== "generate"
        ) {
          throw new CliError(
            "gemini-omni-1.1-flash multiple --ref-video inputs require --video-task generate, --source-video, or --previous-interaction-id.",
            EXIT.USAGE,
          );
        }
        if (
          referenceVideoDurations.length > 0 &&
          (usesLegacyReferenceAsSource ||
            referenceVideoDurations.length !== videoCount)
        ) {
          throw new CliError(
            "Repeat --ref-video-duration once for each creative --ref-video. Do not use it for the legacy single source-video form.",
            EXIT.USAGE,
          );
        }
        if (
          (geminiVideoTask === "edit" || geminiVideoTask === "extend") &&
          !opts.previousInteractionId &&
          !opts.sourceVideo &&
          !usesLegacyReferenceAsSource
        ) {
          throw new CliError(
            `gemini-omni-1.1-flash --video-task ${geminiVideoTask} requires --source-video or --previous-interaction-id.`,
            EXIT.USAGE,
          );
        }
        if ((opts.refAudio?.length ?? 0) > 0) {
          throw new CliError(
            "gemini-omni-1.1-flash does not accept --ref-audio.",
            EXIT.USAGE,
          );
        }
        if (opts.audio === false) {
          throw new CliError(
            "gemini-omni-1.1-flash always generates audio; remove --no-audio.",
            EXIT.USAGE,
          );
        }
        if (
          opts.resolution &&
          !normalizeGeminiOmniResolutionOption(opts.resolution)
        ) {
          throw new CliError(
            "gemini-omni-1.1-flash --resolution must be 360p, 720p, 1080p, or 4k.",
            EXIT.USAGE,
          );
        }
      }

      if (rawElements.length > 0) {
        if (opts.model === "kling-v3-turbo") {
          throw new CliError(
            "Kling 3.0 Turbo does not support --element. Use --model kling-3.0 with --start-image, or kling-o3.",
            EXIT.USAGE,
          );
        }
        if (
          opts.model !== "kling-3.0" &&
          opts.model !== "kling-o3" &&
          opts.model !== "kling-v3-motion-control"
        ) {
          throw new CliError(
            "--element is supported by kling-3.0, kling-o3, and kling-v3-motion-control only.",
            EXIT.USAGE,
          );
        }
        if (opts.model === "kling-3.0" && !opts.startImage) {
          throw new CliError(
            "kling-3.0 --element requires --start-image (elements are image-to-video only).",
            EXIT.USAGE,
          );
        }
        if (
          rawElements.some((element) => element.voice_id) &&
          opts.audio === false
        ) {
          throw new CliError(
            "A Kling element voice_id requires audio. Remove --no-audio.",
            EXIT.USAGE,
          );
        }
        rawElements.forEach((element, index) => {
          const referenceImageCount = element.reference_image_urls?.length ?? 0;
          const hasImage =
            Boolean(element.frontal_image_url) || referenceImageCount > 0;
          const hasVideo = Boolean(element.video_url);
          if (hasImage === hasVideo) {
            throw new CliError(
              `--element ${index + 1} must contain image fields or video_url, but not both.`,
              EXIT.USAGE,
            );
          }
          if (
            !hasVideo &&
            (!element.frontal_image_url || referenceImageCount === 0)
          ) {
            throw new CliError(
              `--element ${index + 1} image mode requires frontal_image_url and 1-3 reference_image_urls.`,
              EXIT.USAGE,
            );
          }
          if (
            referenceImageCount > 3 ||
            element.reference_image_urls?.some((url) => !url)
          ) {
            throw new CliError(
              `--element ${index + 1} reference_image_urls must contain at most 3 non-empty values.`,
              EXIT.USAGE,
            );
          }
          if (hasVideo && (element.reference_image_urls?.length ?? 0) > 0) {
            throw new CliError(
              `--element ${index + 1} cannot combine video_url with reference_image_urls.`,
              EXIT.USAGE,
            );
          }
        });
        if (
          (opts.model === "kling-3.0" || opts.model === "kling-o3") &&
          rawElements.filter((element) => element.video_url).length > 1
        ) {
          throw new CliError(
            `${opts.model} accepts at most one video-backed --element.`,
            EXIT.USAGE,
          );
        }
        if (opts.model === "kling-o3" && (opts.refVideo?.length ?? 0) > 0) {
          throw new CliError(
            "kling-o3 --element cannot be combined with the legacy --ref-video edit mode. Put the element video in --element video_url instead.",
            EXIT.USAGE,
          );
        }
        if (opts.model === "kling-o3") {
          const combinedReferenceCount =
            (opts.ref?.length ?? 0) + rawElements.length;
          const hasVideoElement = rawElements.some(
            (element) => !!element.video_url,
          );
          if (combinedReferenceCount > 7) {
            throw new CliError(
              "kling-o3 accepts at most 7 combined --ref images and image-backed --element entries.",
              EXIT.USAGE,
            );
          }
          if (hasVideoElement && combinedReferenceCount > 4) {
            throw new CliError(
              "kling-o3 accepts at most 4 combined --ref images and --element entries when a video-backed element is used.",
              EXIT.USAGE,
            );
          }
        }
        if (opts.model === "kling-v3-motion-control") {
          const element = rawElements[0];
          const hasElementImages =
            Boolean(element?.frontal_image_url) &&
            (element?.reference_image_urls?.length ?? 0) > 0;
          if (
            rawElements.length !== 1 ||
            !hasElementImages ||
            element?.video_url ||
            element?.voice_id
          ) {
            throw new CliError(
              "kling-v3-motion-control accepts one image-only --element. Provide frontal_image_url and 1-3 reference_image_urls. Use videodraft edit motion for the clearest workflow.",
              EXIT.USAGE,
            );
          }
        }
      }
      if (voiceIds.length > 0) {
        if (opts.model !== "kling-2.6-pro") {
          throw new CliError(
            "--voice-id is supported only by --model kling-2.6-pro. Kling V3/O3 use voice_id inside --element JSON.",
            EXIT.USAGE,
          );
        }
        if (!opts.startImage) {
          throw new CliError(
            "kling-2.6-pro --voice-id requires --start-image.",
            EXIT.USAGE,
          );
        }
        if (
          voiceIds.length > 2 ||
          voiceIds.some((id) => !id.trim() || id.trim().length > 512)
        ) {
          throw new CliError(
            "--voice-id accepts 1 or 2 non-empty string IDs, each no longer than 512 characters.",
            EXIT.USAGE,
          );
        }
        if (new Set(voiceIds.map((id) => id.trim())).size !== voiceIds.length) {
          throw new CliError(
            "--voice-id cannot repeat the same Kling voice ID.",
            EXIT.USAGE,
          );
        }
        if (opts.audio === false) {
          throw new CliError(
            "Kling 2.6 --voice-id requires audio. Remove --no-audio.",
            EXIT.USAGE,
          );
        }
        voiceIds.forEach((voiceId, index) => {
          const marker = `<<<voice_${index + 1}>>>`;
          if (!prompt.includes(marker)) {
            throw new CliError(
              `--voice-id ${index + 1} must be cited in the prompt as ${marker}.`,
              EXIT.USAGE,
            );
          }
        });
      }

      if (opts.model === "grok-imagine-video-1.5") {
        const referenceImageCount = Array.isArray(opts.ref)
          ? opts.ref.length
          : 0;
        if (!prompt) {
          throw new CliError(
            "grok-imagine-video-1.5 requires a prompt.",
            EXIT.USAGE,
          );
        }
        if (prompt.length > 4096) {
          throw new CliError(
            "grok-imagine-video-1.5 prompts must be 4096 characters or fewer.",
            EXIT.USAGE,
          );
        }
        if (
          duration !== undefined &&
          (!Number.isInteger(duration) || duration < 1 || duration > 15)
        ) {
          throw new CliError(
            "grok-imagine-video-1.5 --duration must be a whole second from 1 to 15.",
            EXIT.USAGE,
          );
        }
        if (referenceImageCount > 7) {
          throw new CliError(
            "grok-imagine-video-1.5 accepts at most 7 --ref images.",
            EXIT.USAGE,
          );
        }
        if (referenceImageCount > 0 && opts.startImage) {
          throw new CliError(
            "grok-imagine-video-1.5 cannot combine --ref images with --start-image.",
            EXIT.USAGE,
          );
        }
        if (
          opts.endImage ||
          (opts.refVideo?.length ?? 0) > 0 ||
          (opts.refAudio?.length ?? 0) > 0 ||
          (opts.segment?.length ?? 0) > 0 ||
          opts.negative ||
          opts.cameraFixed ||
          opts.seed !== undefined ||
          opts.quality
        ) {
          throw new CliError(
            "grok-imagine-video-1.5 does not support --end-image, --ref-video, --ref-audio, --segment, --negative, --camera-fixed, --seed, or --quality.",
            EXIT.USAGE,
          );
        }
        if (opts.audio === false) {
          throw new CliError(
            "grok-imagine-video-1.5 always generates native audio; remove --no-audio.",
            EXIT.USAGE,
          );
        }
        if (opts.startImage && opts.ar) {
          throw new CliError(
            "grok-imagine-video-1.5 first-frame mode derives aspect ratio from --start-image; remove --ar.",
            EXIT.USAGE,
          );
        }
        if (
          opts.ar &&
          !["16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"].includes(opts.ar)
        ) {
          throw new CliError(
            "grok-imagine-video-1.5 --ar must be 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, or 9:16.",
            EXIT.USAGE,
          );
        }
        if (
          opts.resolution &&
          !["480p", "720p", "1080p"].includes(opts.resolution)
        ) {
          throw new CliError(
            "grok-imagine-video-1.5 --resolution must be 480p, 720p, or 1080p.",
            EXIT.USAGE,
          );
        }
        if (referenceImageCount > 0 && opts.resolution === "1080p") {
          throw new CliError(
            "grok-imagine-video-1.5 reference mode supports only 480p or 720p.",
            EXIT.USAGE,
          );
        }
      }

      if (opts.model !== "wan-3.0" && hasWan3OnlyControls) {
        throw new CliError(
          "--auto-duration, --prompt-expansion, --thinking, --file-url, and --web-url are supported only by --model wan-3.0.",
          EXIT.USAGE,
        );
      }
      if (opts.model !== "minimax-h3-max" && hasH3MaxOnlyControls) {
        throw new CliError(
          "--prompt-expansion-mode and --safety-checker are supported only by --model minimax-h3-max.",
          EXIT.USAGE,
        );
      }
      if (opts.model === "minimax-h3-max") {
        const imageCount = Array.isArray(opts.ref) ? opts.ref.length : 0;
        const videoCount = Array.isArray(opts.refVideo)
          ? opts.refVideo.length
          : 0;
        const audioCount = Array.isArray(opts.refAudio)
          ? opts.refAudio.length
          : 0;
        if (!prompt) {
          throw new CliError(
            "minimax-h3-max requires a prompt.",
            EXIT.USAGE,
          );
        }
        if (prompt.length > 50000) {
          throw new CliError(
            "minimax-h3-max prompts must be 50000 characters or fewer.",
            EXIT.USAGE,
          );
        }
        if (
          duration !== undefined &&
          (!Number.isInteger(duration) || duration < 5 || duration > 15)
        ) {
          throw new CliError(
            "minimax-h3-max --duration must be a whole second from 5 to 15.",
            EXIT.USAGE,
          );
        }
        if (opts.endImage && !opts.startImage) {
          throw new CliError(
            "minimax-h3-max --end-image requires --start-image.",
            EXIT.USAGE,
          );
        }
        if (opts.startImage && opts.ar) {
          throw new CliError(
            "minimax-h3-max image-to-video follows --start-image framing; remove --ar.",
            EXIT.USAGE,
          );
        }
        if (imageCount > 0 || videoCount > 0 || audioCount > 0) {
          throw new CliError(
            "minimax-h3-max does not support --ref, --ref-video, or --ref-audio. Use --start-image/--end-image for frame control.",
            EXIT.USAGE,
          );
        }
        if (segments.length > 0) {
          throw new CliError(
            "minimax-h3-max does not support --segment.",
            EXIT.USAGE,
          );
        }
        if (
          opts.negative ||
          opts.quality ||
          opts.cameraFixed ||
          (opts.keyframe?.length ?? 0) > 0 ||
          opts.allowRealPeople
        ) {
          throw new CliError(
            "minimax-h3-max does not support --negative, --quality, --camera-fixed, --keyframe, or --allow-real-people.",
            EXIT.USAGE,
          );
        }
        if (opts.audio === false) {
          throw new CliError(
            "minimax-h3-max always generates native audio; remove --no-audio.",
            EXIT.USAGE,
          );
        }
        if (
          opts.resolution &&
          !["480p", "768p"].includes(String(opts.resolution).toLowerCase())
        ) {
          throw new CliError(
            "minimax-h3-max --resolution must be 480p or 768p.",
            EXIT.USAGE,
          );
        }
        if (opts.resolution) {
          opts.resolution = String(opts.resolution).toLowerCase();
        }
        if (
          opts.ar &&
          !["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(
            opts.ar,
          )
        ) {
          throw new CliError(
            "minimax-h3-max --ar must be 21:9, 16:9, 4:3, 1:1, 3:4, or 9:16.",
            EXIT.USAGE,
          );
        }
      }
      if (opts.model === "wan-3.0") {
        const imageCount = Array.isArray(opts.ref) ? opts.ref.length : 0;
        const videoCount = Array.isArray(opts.refVideo)
          ? opts.refVideo.length
          : 0;
        const audioCount = Array.isArray(opts.refAudio)
          ? opts.refAudio.length
          : 0;
        const mediaReferenceCount = imageCount + videoCount + audioCount;
        const hasLinkReference = Boolean(opts.fileUrl || opts.webUrl);
        if (opts.autoDuration && duration !== undefined) {
          throw new CliError(
            "--auto-duration and --duration are mutually exclusive.",
            EXIT.USAGE,
          );
        }
        if (
          duration !== undefined &&
          (!Number.isInteger(duration) || duration < 2 || duration > 30)
        ) {
          throw new CliError(
            "wan-3.0 --duration must be a whole second from 2 to 30.",
            EXIT.USAGE,
          );
        }
        if (prompt.length > 5000) {
          throw new CliError(
            "wan-3.0 prompts must be 5000 characters or fewer.",
            EXIT.USAGE,
          );
        }
        if (opts.endImage && !opts.startImage) {
          throw new CliError(
            "wan-3.0 --end-image requires --start-image.",
            EXIT.USAGE,
          );
        }
        if ((mediaReferenceCount > 0 || hasLinkReference) && opts.startImage) {
          throw new CliError(
            "wan-3.0 cannot combine frame inputs with reference sources.",
            EXIT.USAGE,
          );
        }
        if (imageCount > 10 || videoCount > 5 || audioCount > 5) {
          throw new CliError(
            "wan-3.0 accepts up to 10 --ref images, 5 --ref-video clips, and 5 --ref-audio clips.",
            EXIT.USAGE,
          );
        }
        if (mediaReferenceCount > 20) {
          throw new CliError(
            "wan-3.0 accepts at most 20 image/video/audio reference files in total.",
            EXIT.USAGE,
          );
        }
        if (hasLinkReference && opts.thinking !== true) {
          throw new CliError(
            "wan-3.0 --file-url and --web-url require --thinking.",
            EXIT.USAGE,
          );
        }
        if (opts.negative) {
          throw new CliError(
            "wan-3.0 does not support --negative.",
            EXIT.USAGE,
          );
        }
        if (seed !== undefined && seed > 2147483647) {
          throw new CliError(
            "wan-3.0 --seed must be a whole number from 0 to 2147483647.",
            EXIT.USAGE,
          );
        }
        if (
          opts.resolution &&
          !["480p", "720p", "1080p"].includes(opts.resolution)
        ) {
          throw new CliError(
            "wan-3.0 --resolution must be 480p, 720p, or 1080p.",
            EXIT.USAGE,
          );
        }
        if (
          opts.ar &&
          !["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(
            opts.ar,
          )
        ) {
          throw new CliError(
            "wan-3.0 --ar must be adaptive, 16:9, 4:3, 1:1, 3:4, or 9:16.",
            EXIT.USAGE,
          );
        }
      }

      if (opts.estimate) {
        const estimateModel = estimateVideoModel(opts, duration);
        const refVideoWindow = refVideoSecondsWindow(estimateModel);
        if (
          refVideoSeconds !== undefined &&
          refVideoWindow !== null &&
          refVideoSeconds > refVideoWindow
        ) {
          throw new CliError(
            `--ref-video-seconds must be from 0 to ${refVideoWindow} for ${estimateModel}.`,
            EXIT.USAGE,
          );
        }
        const estimateReferenceImageCount =
          estimateModel === "minimax-h3"
            ? Array.isArray(opts.ref)
              ? opts.ref.length
              : 0
            : estimateModel === "grok-imagine-video-1.5"
              ? Array.isArray(opts.ref) && opts.ref.length > 0
                ? opts.ref.length
                : opts.startImage
                  ? 1
                  : 0
              : undefined;
        // Seedance 2.x bills (input + output) seconds, so its estimate needs
        // this or every reference-video quote is short. MiniMax H3 no longer
        // bills reference video at all, so it resolves to 0 there.
        const hasRefVideos =
          Array.isArray(opts.refVideo) && opts.refVideo.length > 0;
        // Seedance 2.x bills (input + output) seconds, so its estimate needs
        // this or every reference-video quote is short. MiniMax H3 no longer
        // bills reference video, but its existing 0 is preserved so a plain
        // estimate keeps the payload shape its tests assert.
        const estimateReferenceVideoDuration =
          estimateModel === "minimax-h3"
            ? hasRefVideos
              ? refVideoSeconds
              : 0
            : refVideoWindow !== null && hasRefVideos
              ? refVideoSeconds
              : undefined;
        const estimateDuration =
          (segments.length > 0 ? segmentDuration : duration) ??
          (estimateModel === "grok-imagine-video-1.5"
            ? Array.isArray(opts.ref) && opts.ref.length > 0
              ? 8
              : 6
            : !opts.model && estimateModel === "google-veo3.1"
              ? Array.isArray(opts.ref) && opts.ref.length > 0
                ? 8
                : 6
              : undefined);
        await printEstimate(ctx, {
          model: estimateModel,
          type: "video",
          duration: estimateDuration,
          autoDuration: opts.autoDuration === true,
          resolution: opts.resolution,
          quality: opts.quality,
          audio: opts.audio,
          referenceImageCount: estimateReferenceImageCount,
          referenceVideoDurationSeconds: estimateReferenceVideoDuration,
          voiceControl:
            voiceIds.length > 0 ||
            rawElements.some((element) => element.voice_id),
          allowRealPeople: opts.allowRealPeople,
        });
        return;
      }

      const [
        refs,
        refVideos,
        refAudios,
        startImage,
        endImage,
        sourceVideo,
        elements,
      ] =
        await Promise.all([
          resolveRefs(ctx, opts.ref ?? []),
          resolveRefs(ctx, opts.refVideo ?? []),
          resolveRefs(ctx, opts.refAudio ?? []),
          opts.startImage
            ? resolveRefs(ctx, [opts.startImage]).then((r) => r[0])
            : undefined,
          opts.endImage
            ? resolveRefs(ctx, [opts.endImage]).then((r) => r[0])
            : undefined,
          opts.sourceVideo
            ? resolveRefs(ctx, [opts.sourceVideo]).then((r) => r[0])
            : undefined,
          resolveKlingElements(ctx, rawElements),
        ]);
      // Keyframe images may be local paths, so upload them the same way refs
      // are handled, then re-attach each one's position by index.
      const parsedKeyframes = parseKeyframes(opts.keyframe ?? []);
      const keyframes =
        parsedKeyframes.length > 0
          ? await resolveRefs(
              ctx,
              parsedKeyframes.map((keyframe) => keyframe.source),
            ).then((urls) =>
              parsedKeyframes.map((keyframe, index) => ({
                image_url: urls[index],
                time_seconds: keyframe.time_seconds,
              })),
            )
          : [];

      // A video needs at least one driver. The server enforces per-model rules;
      // this just catches an entirely empty invocation early.
      if (
        !prompt &&
        segments.length === 0 &&
        !startImage &&
        keyframes.length === 0 &&
        refs.length === 0 &&
        refVideos.length === 0 &&
        refAudios.length === 0 &&
        !sourceVideo &&
        !opts.fileUrl &&
        !opts.webUrl &&
        !opts.previousInteractionId
      ) {
        throw new CliError(
          "Provide a prompt, --segment, a frame, or a reference source.",
          EXIT.USAGE,
        );
      }

      capture("cli_generate", {
        kind: "video",
        model: opts.model ?? "default",
        wait: opts.wait !== false,
      });
      const videoEditModels = new Set([
        "happy-horse-video-edit",
        "grok-imagine-video-edit",
      ]);
      const motionControlModels = new Set([
        "kling-v3-motion-control",
        "kling-2.6-motion-control",
      ]);
      let toolName = "generate_video";
      let toolArgs: Record<string, unknown>;
      if (videoEditModels.has(opts.model)) {
        if (refVideos.length !== 1) {
          throw new CliError(
            `${opts.model} requires exactly one --ref-video source. You can also use videodraft edit video.`,
            EXIT.USAGE,
          );
        }
        if (
          startImage ||
          endImage ||
          refAudios.length > 0 ||
          segments.length > 0 ||
          opts.ar ||
          opts.negative ||
          opts.cameraFixed ||
          opts.seed ||
          elements.length > 0 ||
          voiceIds.length > 0
        ) {
          throw new CliError(
            `${opts.model} does not support --start-image, --end-image, --ref-audio, --element, --voice-id, --segment, --ar, --negative, --camera-fixed, or --seed in video-edit mode. Use --ref for supported reference images.`,
            EXIT.USAGE,
          );
        }
        toolName = "edit_video";
        toolArgs = {
          model: opts.model,
          prompt: prompt || undefined,
          video_url: refVideos[0],
          reference_images: refs.length > 0 ? refs : undefined,
          resolution: opts.resolution,
          quality: opts.quality,
          duration_seconds: duration,
          preserve_audio: opts.audio,
          project_id: opts.project,
          session_id: sessionArg(this, opts),
          scene_index:
            opts.scene !== undefined ? Number(opts.scene) : undefined,
          shot_index: opts.shot !== undefined ? Number(opts.shot) : undefined,
        };
      } else if (motionControlModels.has(opts.model)) {
        if (!startImage || refVideos.length !== 1) {
          throw new CliError(
            `${opts.model} requires --start-image plus exactly one --ref-video motion source. You can also use videodraft edit motion.`,
            EXIT.USAGE,
          );
        }
        if (
          endImage ||
          refs.length > 0 ||
          refAudios.length > 0 ||
          segments.length > 0 ||
          opts.ar ||
          opts.negative ||
          opts.cameraFixed ||
          opts.seed ||
          opts.resolution ||
          voiceIds.length > 0
        ) {
          throw new CliError(
            `${opts.model} does not support --end-image, --ref, --ref-audio, --voice-id, --segment, --ar, --negative, --camera-fixed, --seed, or --resolution in motion-control mode.`,
            EXIT.USAGE,
          );
        }
        if (duration !== undefined) {
          throw new CliError(
            `${opts.model} follows the motion video duration and orientation cap; use videodraft edit motion --estimate for a duration-based estimate.`,
            EXIT.USAGE,
          );
        }
        toolName = "generate_motion_control_video";
        const resolvedElement = elements[0];
        toolArgs = {
          model: opts.model,
          prompt: prompt || undefined,
          image_url: startImage,
          motion_video_url: refVideos[0],
          quality: opts.quality,
          keep_original_sound: opts.audio,
          character_orientation: elements.length > 0 ? "video" : undefined,
          duration_seconds: duration,
          project_id: opts.project,
          session_id: sessionArg(this, opts),
          scene_index:
            opts.scene !== undefined ? Number(opts.scene) : undefined,
          shot_index: opts.shot !== undefined ? Number(opts.shot) : undefined,
          element:
            elements.length === 1 && resolvedElement
              ? {
                  frontal_image_url: resolvedElement.frontal_image_url,
                  reference_image_urls: resolvedElement.reference_image_urls,
                }
              : undefined,
        };
      } else {
        toolArgs = {
          prompt: prompt || undefined,
          model: opts.model,
          aspect_ratio: opts.ar,
          duration_seconds: duration,
          auto_duration: opts.autoDuration ? true : undefined,
          resolution: opts.resolution,
          quality: opts.quality,
          generate_audio: opts.audio,
          allow_real_people: opts.allowRealPeople ? true : undefined,
          start_image_url: startImage,
          end_image_url: endImage,
          reference_images: refs.length > 0 ? refs : undefined,
          video_url: sourceVideo,
          reference_videos: refVideos.length > 0 ? refVideos : undefined,
          reference_video_durations:
            referenceVideoDurations.length > 0
              ? referenceVideoDurations
              : undefined,
          reference_audio: refAudios.length > 0 ? refAudios : undefined,
          file_url: opts.fileUrl,
          web_url: opts.webUrl,
          previous_interaction_id: opts.previousInteractionId,
          video_task: geminiVideoTask,
          enable_prompt_expansion: promptExpansion,
          prompt_expansion_mode: promptExpansionMode,
          enable_safety_checker: safetyChecker,
          enable_thinking: opts.thinking ? true : undefined,
          elements: elements.length > 0 ? elements : undefined,
          voice_ids:
            voiceIds.length > 0
              ? voiceIds.map((voiceId) => voiceId.trim())
              : undefined,
          multi_prompt: segments.length > 0 ? segments : undefined,
          keyframes: keyframes.length > 0 ? keyframes : undefined,
          negative_prompt: opts.negative,
          camera_fixed: opts.cameraFixed ? true : undefined,
          seed,
          project_id: opts.project,
          session_id: sessionArg(this, opts),
          scene_index:
            opts.scene !== undefined ? Number(opts.scene) : undefined,
          shot_index: opts.shot !== undefined ? Number(opts.shot) : undefined,
        };
      }
      const submitted = await ctx.client.callTool(toolName, compact(toolArgs));
      await handleAsyncJob(ctx, submitted, {
        wait: opts.wait !== false,
        download: opts.download,
        label: "Generating video",
      });
    });

  generate
    .command("audio <prompt...>")
    .description(
      "Generate or edit audio with ByteDance Seed Audio 1.0 (synchronous)",
    )
    .option("--voice <id>", "preset Seed Audio voice or custom cloned voice id")
    .option(
      "--ref-audio <url|file>",
      "reference audio for @Audio1..@Audio3 (repeatable; local files uploaded)",
      collect,
      [],
    )
    .option(
      "--image <url|file>",
      "reference image (cannot be combined with --ref-audio)",
    )
    .option("--format <wav|mp3|pcm|ogg_opus>", "output format (default mp3)")
    .option(
      "--sample-rate <hz>",
      "8000 | 16000 | 24000 | 32000 | 44100 | 48000 (default 24000)",
    )
    .option("--speed <0.5-2>", "playback speed multiplier (default 1)")
    .option("--volume <0.5-2>", "volume multiplier (default 1)")
    .option("--pitch <-12-12>", "pitch in whole semitones (default 0)")
    .option("--project <id>", "link to a project's AI Studio session")
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option(
      "--idempotency-key <uuid>",
      "set a stable UUID for recovery after a process interruption",
    )
    .option("--download <path>", "download the generated audio file")
    .option(
      "--estimate",
      "show 19 credits/minute pricing and the 38-credit maximum reservation",
    )
    .action(async function (this: Command, promptWords: string[]) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const prompt = promptWords.join(" ").trim();
      if (!prompt) {
        throw new CliError("A Seed Audio prompt is required.", EXIT.USAGE);
      }
      if (prompt.length > SEED_AUDIO_PROMPT_MAX_CHARS) {
        throw new CliError(
          `Seed Audio prompts must be ${SEED_AUDIO_PROMPT_MAX_CHARS} characters or fewer.`,
          EXIT.USAGE,
        );
      }
      const rawAudioRefs = (opts.refAudio ?? []) as string[];
      if (rawAudioRefs.length > SEED_AUDIO_MAX_REFERENCES) {
        throw new CliError(
          `Seed Audio accepts at most ${SEED_AUDIO_MAX_REFERENCES} --ref-audio values.`,
          EXIT.USAGE,
        );
      }
      if (opts.image && rawAudioRefs.length > 0) {
        throw new CliError(
          "--image and --ref-audio cannot be used together.",
          EXIT.USAGE,
        );
      }
      const outputFormat = opts.format ?? "mp3";
      if (!SEED_AUDIO_FORMATS.includes(outputFormat)) {
        throw new CliError(
          `--format must be one of: ${SEED_AUDIO_FORMATS.join(", ")}.`,
          EXIT.USAGE,
        );
      }
      const sampleRate = opts.sampleRate ? Number(opts.sampleRate) : 24000;
      if (!SEED_AUDIO_SAMPLE_RATES.includes(sampleRate as any)) {
        throw new CliError(
          `--sample-rate must be one of: ${SEED_AUDIO_SAMPLE_RATES.join(", ")}.`,
          EXIT.USAGE,
        );
      }
      const speed = optionalRangedNumber(opts.speed, "--speed", 0.5, 2);
      const volume = optionalRangedNumber(opts.volume, "--volume", 0.5, 2);
      const pitch = optionalRangedNumber(opts.pitch, "--pitch", -12, 12, true);
      const idempotencyKey = opts.idempotencyKey ?? randomUUID();
      if (!UUID_RE.test(idempotencyKey)) {
        throw new CliError(
          "--idempotency-key must be a valid UUID.",
          EXIT.USAGE,
        );
      }

      if (opts.estimate) {
        await printEstimate(ctx, {
          model: "seed-audio-1.0",
          type: "audio",
        });
        return;
      }

      const [audioUrls, imageUrl] = await Promise.all([
        resolveRefs(ctx, rawAudioRefs),
        opts.image
          ? resolveRefs(ctx, [opts.image]).then((urls) => urls[0])
          : undefined,
      ]);
      capture("cli_generate", { kind: "audio", model: "seed-audio-1.0" });
      const toolArgs = compact({
        prompt,
        voice: opts.voice,
        audio_urls: audioUrls.length > 0 ? audioUrls : undefined,
        image_url: imageUrl,
        output_format: outputFormat,
        sample_rate: sampleRate,
        speed,
        volume,
        pitch,
        project_id: opts.project,
        session_id: sessionArg(this, opts),
        idempotency_key: idempotencyKey,
      });
      let result: any;
      try {
        result = await callAudioWithRetry(() =>
          ctx.client.callTool("generate_audio", toolArgs),
        );
      } catch (error) {
        const hint = isRetryableAudioError(error)
          ? `Retry this exact request with --idempotency-key ${idempotencyKey}`
          : undefined;
        if (error instanceof CliError) {
          if (hint) error.hint = hint;
          throw error;
        }
        throw new CliError(
          error instanceof Error ? error.message : "Audio generation failed",
          EXIT.ERROR,
          hint,
        );
      }
      const urls = extractOutputUrls(result);
      let downloaded: DownloadedFile[] | undefined;
      if (opts.download && urls.length > 0) {
        downloaded = await downloadOutputs(urls, opts.download, {
          name: "seed-audio",
        });
      }
      const media = buildMediaDescriptors(urls, "audio");
      emit(
        ctx.out,
        { ...result, downloaded_files: downloaded, output_media: media },
        (o) => {
          for (const url of urls) process.stdout.write(`${url}\n`);
          for (const file of downloaded ?? []) {
            note(o, fmt.dim(o, savedLine(file)));
          }
        },
      );
    });

  generate
    .command("voiceover <text...>")
    .description("Generate TTS audio (synchronous — returns an audio URL)")
    .option("--voice <id>", "voice id (see `videodraft models voices`)")
    .option("--language <bcp47>", 'target language, default "en"')
    .option("--project <id>", "attach to a project")
    .option(
      "--scene <n>",
      "0-based scene index; wires the audio onto that scene",
    )
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--download <path>", "download the audio file")
    .action(async function (this: Command, textWords: string[]) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      capture("cli_generate", { kind: "voiceover" });
      const result: any = await ctx.client.callTool(
        "generate_voiceover",
        compact({
          text: textWords.join(" "),
          voice_id: opts.voice,
          target_language: opts.language,
          project_id: opts.project,
          session_id: sessionArg(this, opts),
          scene_index:
            opts.scene !== undefined ? Number(opts.scene) : undefined,
        }),
      );
      const urls = extractOutputUrls(result);
      let downloaded: DownloadedFile[] | undefined;
      if (opts.download && urls.length > 0) {
        downloaded = await downloadOutputs(urls, opts.download, {
          name: "voiceover",
        });
      }
      const media = buildMediaDescriptors(urls, "audio");
      emit(
        ctx.out,
        { ...result, downloaded_files: downloaded, output_media: media },
        (o) => {
          for (const url of urls) process.stdout.write(`${url}\n`);
          for (const f of downloaded ?? []) note(o, fmt.dim(o, savedLine(f)));
        },
      );
    });

  generate
    .command("music <prompt...>")
    .description("Generate background music")
    .option(
      "--model <id>",
      "lyria-3-clip-preview (default) | lyria-3-pro-preview | elevenlabs-music",
    )
    .option(
      "--length <seconds>",
      "for --model elevenlabs-music: length 10–120s (default 30)",
    )
    .option(
      "--instrumental",
      "for --model elevenlabs-music: force instrumental (no vocals)",
    )
    .option(
      "--ref <url|file>",
      "reference image to inspire the music (Lyria only, repeatable)",
      collect,
      [],
    )
    .option(
      "--project <id>",
      "link the generation to a project's AI Studio session",
    )
    .option(
      "--attach <project_id>",
      "also set the track as that project's background music",
    )
    .option("--volume <n>", "0-100 BGM volume when attaching (default 30)")
    .option(
      "--bgm-disabled",
      "when attaching, store the BGM as disabled (enabled:false)",
    )
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--download <path>", "download the audio file")
    .action(async function (this: Command, promptWords: string[]) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const musicModel = opts.model ?? "lyria-3-clip-preview";
      const refs =
        musicModel === "elevenlabs-music"
          ? []
          : await resolveRefs(ctx, opts.ref ?? []);
      capture("cli_generate", { kind: "music", model: musicModel });
      const result: any = await ctx.client.callTool(
        "generate_music",
        compact({
          prompt: promptWords.join(" "),
          model: musicModel,
          length_seconds: opts.length ? Number(opts.length) : undefined,
          force_instrumental: opts.instrumental ? true : undefined,
          image_urls: refs.length > 0 ? refs : undefined,
          project_id: opts.project,
          attach_to_project_id: opts.attach,
          volume: opts.volume ? Number(opts.volume) : undefined,
          enabled: opts.bgmDisabled ? false : undefined,
          session_id: sessionArg(this, opts),
        }),
      );
      const urls = extractOutputUrls(result);
      let downloaded: DownloadedFile[] | undefined;
      if (opts.download && urls.length > 0) {
        downloaded = await downloadOutputs(urls, opts.download, {
          name: "music",
        });
      }
      const media = buildMediaDescriptors(urls, "music");
      emit(
        ctx.out,
        { ...result, downloaded_files: downloaded, output_media: media },
        (o) => {
          for (const url of urls) process.stdout.write(`${url}\n`);
          for (const f of downloaded ?? []) note(o, fmt.dim(o, savedLine(f)));
        },
      );
    });

  generate
    .command("sound-effect <prompt...>")
    .description("Generate a sound effect (ElevenLabs Sound Effects)")
    .option("--duration <seconds>", "length 0.5–22s (default 5)")
    .option("--influence <0-1>", "prompt influence (default 0.3)")
    .option("--project <id>", "link to a project's AI Studio session")
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--download <path>", "download the audio file")
    .action(async function (this: Command, promptWords: string[]) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      capture("cli_generate", { kind: "sound_effect" });
      const result: any = await ctx.client.callTool(
        "generate_sound_effect",
        compact({
          prompt: promptWords.join(" "),
          duration_seconds: opts.duration ? Number(opts.duration) : undefined,
          prompt_influence: opts.influence ? Number(opts.influence) : undefined,
          project_id: opts.project,
          session_id: sessionArg(this, opts),
        }),
      );
      const urls = extractOutputUrls(result);
      let downloaded: DownloadedFile[] | undefined;
      if (opts.download && urls.length > 0) {
        downloaded = await downloadOutputs(urls, opts.download, {
          name: "sound-effect",
        });
      }
      const media = buildMediaDescriptors(urls, "audio");
      emit(
        ctx.out,
        { ...result, downloaded_files: downloaded, output_media: media },
        (o) => {
          for (const url of urls) process.stdout.write(`${url}\n`);
          for (const f of downloaded ?? []) note(o, fmt.dim(o, savedLine(f)));
        },
      );
    });

  generate
    .command("dialogue")
    .description(
      "Generate multi-speaker dialogue (ElevenLabs Text-to-Dialogue). Repeat --line.",
    )
    .option(
      "--line <voiceId:text>",
      'a dialogue line as "voiceId:text" (repeatable)',
      collect,
      [],
    )
    .option("--stability <0|0.5|1>", "voice stability")
    .option("--language <iso>", "ISO 639-1 language code")
    .option("--project <id>", "link to a project's AI Studio session")
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--download <path>", "download the audio file")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const lines = (opts.line as string[]).map((raw) => {
        const i = raw.indexOf(":");
        if (i < 0) {
          throw new Error(`--line must be "voiceId:text" (got "${raw}")`);
        }
        return {
          voice_id: raw.slice(0, i).trim(),
          text: raw.slice(i + 1).trim(),
        };
      });
      if (lines.length === 0)
        throw new Error("at least one --line is required");
      capture("cli_generate", { kind: "dialogue" });
      const result: any = await ctx.client.callTool(
        "generate_dialogue",
        compact({
          lines,
          stability:
            opts.stability !== undefined ? Number(opts.stability) : undefined,
          language_code: opts.language,
          project_id: opts.project,
          session_id: sessionArg(this, opts),
        }),
      );
      const urls = extractOutputUrls(result);
      let downloaded: DownloadedFile[] | undefined;
      if (opts.download && urls.length > 0) {
        downloaded = await downloadOutputs(urls, opts.download, {
          name: "dialogue",
        });
      }
      const media = buildMediaDescriptors(urls, "audio");
      emit(
        ctx.out,
        { ...result, downloaded_files: downloaded, output_media: media },
        (o) => {
          for (const url of urls) process.stdout.write(`${url}\n`);
          for (const f of downloaded ?? []) note(o, fmt.dim(o, savedLine(f)));
        },
      );
    });

  generate
    .command("voice-changer <audio>")
    .description("Restyle speech into another ElevenLabs voice (Voice Changer)")
    .option("--voice <id>", "target ElevenLabs voice id (default Brittney)")
    .option(
      "--duration <seconds>",
      "length of the source audio in seconds (required, max 300)",
    )
    .option("--remove-noise", "remove background noise from the input")
    .option("--project <id>", "link to a project's AI Studio session")
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--download <path>", "download the audio file")
    .action(async function (this: Command, source: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      if (!opts.duration) {
        throw new Error(
          "--duration <seconds> is required (length of the source audio)",
        );
      }
      const [audioUrl] = await resolveRefs(ctx, [source]);
      capture("cli_generate", { kind: "voice_changer" });
      const result: any = await ctx.client.callTool(
        "change_voice",
        compact({
          audio_url: audioUrl,
          voice_id: opts.voice,
          duration_seconds: Number(opts.duration),
          remove_background_noise: opts.removeNoise ? true : undefined,
          project_id: opts.project,
          session_id: sessionArg(this, opts),
        }),
      );
      const urls = extractOutputUrls(result);
      let downloaded: DownloadedFile[] | undefined;
      if (opts.download && urls.length > 0) {
        downloaded = await downloadOutputs(urls, opts.download, {
          name: "voice-changed",
        });
      }
      const media = buildMediaDescriptors(urls, "audio");
      emit(
        ctx.out,
        { ...result, downloaded_files: downloaded, output_media: media },
        (o) => {
          for (const url of urls) process.stdout.write(`${url}\n`);
          for (const f of downloaded ?? []) note(o, fmt.dim(o, savedLine(f)));
        },
      );
    });

  generate
    .command("dub <media>")
    .description(
      "Dub a video/audio file into another language (ElevenLabs Dubbing)",
    )
    .option(
      "--to <iso>",
      "target language ISO 639-1 code, e.g. es or te (required)",
    )
    .option(
      "--from <iso>",
      "source language ISO 639-1 code (auto-detected if omitted)",
    )
    .option("--type <audio|video>", "source media type override")
    .option(
      "--duration <seconds>",
      "length of the source media in seconds (required, max 300)",
    )
    .option("--speakers <n>", "number of speakers (auto-detected if omitted)")
    .option("--project <id>", "link to a project's AI Studio session")
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--download <path>", "download the dubbed file")
    .action(async function (this: Command, source: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      if (!opts.to) throw new Error("--to <iso> (target language) is required");
      if (!opts.duration) {
        throw new Error(
          "--duration <seconds> is required (length of the source media)",
        );
      }
      const mediaType = inferDubMediaType(source, opts.type);
      const [mediaUrl] = await resolveRefs(ctx, [source]);
      capture("cli_generate", { kind: "dub" });
      const result: any = await ctx.client.callTool(
        "dub_media",
        compact({
          video_url: mediaType === "video" ? mediaUrl : undefined,
          audio_url: mediaType === "audio" ? mediaUrl : undefined,
          target_lang: opts.to,
          source_lang: opts.from,
          num_speakers: opts.speakers ? Number(opts.speakers) : undefined,
          duration_seconds: Number(opts.duration),
          project_id: opts.project,
          session_id: sessionArg(this, opts),
        }),
      );
      const urls = extractOutputUrls(result);
      let downloaded: DownloadedFile[] | undefined;
      if (opts.download && urls.length > 0) {
        downloaded = await downloadOutputs(urls, opts.download, {
          name: "dubbed",
        });
      }
      const media = buildMediaDescriptors(urls, mediaType);
      emit(
        ctx.out,
        { ...result, downloaded_files: downloaded, output_media: media },
        (o) => {
          for (const url of urls) process.stdout.write(`${url}\n`);
          for (const f of downloaded ?? []) note(o, fmt.dim(o, savedLine(f)));
        },
      );
    });

  const upscale = program
    .command("upscale")
    .description("Upscale images and videos (Topaz)");

  upscale
    .command("image <url|file>")
    .description(
      "Enhance or upscale an existing image with Topaz (synchronous)",
    )
    .option("--scale <factor>", '"1x" | "2x" | "4x" (default 2x)')
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--download <path>", "download the result")
    .action(async function (this: Command, source: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const [url] = await resolveRefs(ctx, [source]);
      capture("cli_upscale", { kind: "image" });
      const result: any = await ctx.client.callTool(
        "upscale_image",
        compact({
          image_url: url,
          scale: opts.scale,
          session_id: sessionArg(this, opts),
        }),
      );
      const urls = extractOutputUrls(result);
      let downloaded: DownloadedFile[] | undefined;
      if (opts.download && urls.length > 0) {
        downloaded = await downloadOutputs(urls, opts.download, {
          name: "upscaled",
        });
      }
      const media = buildMediaDescriptors(urls, "image");
      emit(
        ctx.out,
        { ...result, downloaded_files: downloaded, output_media: media },
        (o) => {
          for (const u of urls) process.stdout.write(`${u}\n`);
          for (const f of downloaded ?? []) note(o, fmt.dim(o, savedLine(f)));
        },
      );
    });

  upscale
    .command("video <url|file>")
    .description(
      "Enhance or upscale an existing video with Topaz (async; waits by default)",
    )
    .option("--scale <factor>", 'e.g. "2x" (default)')
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option(
      "--duration <seconds>",
      "source duration override (only if auto-probe fails, e.g. >100MB)",
    )
    .option("--width <px>", "source width override (only if auto-probe fails)")
    .option(
      "--height <px>",
      "source height override (only if auto-probe fails)",
    )
    .option("--download <path>", "download the result")
    .option("--no-wait", "submit and return the job id immediately")
    .action(async function (this: Command, source: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const [url] = await resolveRefs(ctx, [source]);
      capture("cli_upscale", { kind: "video" });
      const submitted = await ctx.client.callTool(
        "upscale_video",
        compact({
          video_url: url,
          scale: opts.scale,
          session_id: sessionArg(this, opts),
          duration_seconds: opts.duration ? Number(opts.duration) : undefined,
          video_width: opts.width ? Number(opts.width) : undefined,
          video_height: opts.height ? Number(opts.height) : undefined,
        }),
      );
      await handleAsyncJob(ctx, submitted, {
        wait: opts.wait !== false,
        download: opts.download,
        label: "Upscaling video",
      });
    });
}
