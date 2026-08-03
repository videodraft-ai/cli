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
  type CommandContext,
} from "../cli/context.js";
import { emit, fmt, note, spinner } from "../cli/output.js";
import { pollGeneration, extractOutputUrls } from "../core/poll.js";
import { buildMediaDescriptors } from "../core/media.js";
import { downloadOutputs, savedLine, type DownloadedFile } from "../core/download.js";
import { uploadFile } from "../core/upload.js";
import {
  callAudioWithRetry,
  isRetryableAudioError,
} from "../core/audio-retry.js";
import { capture } from "../cli/telemetry.js";
import { CliError, EXIT } from "../core/errors.js";

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
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CliError(
      "--seed must be a non-negative safe integer.",
      EXIT.USAGE,
    );
  }
  return parsed;
}

function estimateVideoModel(
  opts: Record<string, any>,
  duration: number | undefined,
): string {
  if (opts.model) return opts.model;
  const referenceImageCount = Array.isArray(opts.ref) ? opts.ref.length : 0;
  const referenceVideoCount = Array.isArray(opts.refVideo)
    ? opts.refVideo.length
    : 0;
  const referenceAudioCount = Array.isArray(opts.refAudio)
    ? opts.refAudio.length
    : 0;
  const seedanceTask =
    (duration !== undefined && duration > 10) ||
    referenceVideoCount > 1 ||
    referenceAudioCount > 0 ||
    (referenceVideoCount > 0 && referenceImageCount > 0) ||
    opts.quality === "mini" ||
    opts.quality === "standard";
  if (seedanceTask) return "seedance-2";

  const veoTask =
    Boolean(opts.endImage) ||
    opts.audio === false ||
    opts.quality === "fast" ||
    opts.quality === "quality" ||
    (typeof opts.resolution === "string" && opts.resolution !== "720p");
  if (veoTask) {
    return referenceVideoCount > 0 ? "seedance-2" : "google-veo3.1";
  }
  return "gemini-omni-flash";
}

async function printEstimate(
  ctx: CommandContext,
  params: {
    model?: string;
    type: "image" | "video" | "audio";
    duration?: number;
    resolution?: string;
    quality?: string;
    renderingSpeed?: string;
    audio?: boolean;
    num?: number;
    referenceImageCount?: number;
    referenceVideoDurationSeconds?: number;
  },
): Promise<void> {
  const estimate = await ctx.client.callTool(
    "get_model_costs",
    compact({
      model_id: params.model,
      type: params.type,
      duration_seconds: params.duration,
      resolution: params.resolution,
      quality: params.quality,
      rendering_speed: params.renderingSpeed,
      generate_audio: params.audio,
      reference_image_count: params.referenceImageCount,
      reference_video_duration_seconds: params.referenceVideoDurationSeconds,
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
    emit(
      ctx.out,
      {
        job_id: jobId,
        status: result.status,
        outputs: result.outputUrls,
        downloaded_files: downloaded,
        output_media: media,
      },
      (o) => {
        note(o, fmt.green(o, `Completed — job ${jobId}`));
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
    .option("--session <id>", "AI Studio session id")
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
          session_id: opts.session,
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
    .option("--resolution <res>", 'e.g. "480p", "720p", "1080p", "2K", "4k"')
    .option(
      "--quality <tier>",
      'e.g. "mini", "fast", "standard", "quality", "pro"',
    )
    .option("--audio", "generate native model audio")
    .option("--no-audio", "disable native model audio")
    .option("--start-image <url|file>", "start frame (image-to-video)")
    .option("--end-image <url|file>", "end frame (supported models only)")
    .option("--ref <url|file>", "reference image (repeatable)", collect, [])
    .option(
      "--ref-video <url|file>",
      "reference video (repeatable; MiniMax H3, Gemini Omni Flash, Seedance 2, Wan 2.7, Kling/Wan Ref-Edit; local files uploaded)",
      collect,
      [],
    )
    .option(
      "--ref-audio <url|file>",
      "reference audio (repeatable; MiniMax H3 or Seedance 2; local files uploaded)",
      collect,
      [],
    )
    .option(
      "--ref-video-seconds <seconds>",
      "combined reference-video duration for an exact MiniMax H3 --estimate",
    )
    .option(
      "--segment <prompt:seconds>",
      "multi-prompt segment (repeatable; Kling 3.0 / 3.0 Turbo / O3)",
      collect,
      [],
    )
    .option("--negative <text>", "negative prompt (Kling/Wan/Luma)")
    .option("--camera-fixed", "Seedance 1.5 Pro: lock camera motion")
    .option("--seed <n>", "seed")
    .option("--project <id>", "attach to a project")
    .option("--session <id>", "AI Studio session id")
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
      // prompt is OPTIONAL: Kling 3.0 / 3.0 Turbo / O3 allow multi-prompt-only
      // calls, and Kling 3.0 Turbo allows image-to-video with no prompt.
      const prompt = promptWords.join(" ").trim();
      const duration = optionalPositiveNumber(opts.duration, "--duration");
      const refVideoSeconds = optionalRangedNumber(
        opts.refVideoSeconds,
        "--ref-video-seconds",
        0,
        15,
      );
      const seed = optionalSeed(opts.seed);

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
          !["16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"].includes(
            opts.ar,
          )
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

      if (opts.estimate) {
        const estimateModel = estimateVideoModel(opts, duration);
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
        const estimateReferenceVideoDuration =
          estimateModel === "minimax-h3"
            ? Array.isArray(opts.refVideo) && opts.refVideo.length > 0
              ? refVideoSeconds
              : 0
            : undefined;
        const estimateDuration =
          duration ??
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
          resolution: opts.resolution,
          quality: opts.quality,
          audio: opts.audio,
          referenceImageCount: estimateReferenceImageCount,
          referenceVideoDurationSeconds: estimateReferenceVideoDuration,
        });
        return;
      }

      const [refs, refVideos, refAudios, startImage, endImage] =
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
        ]);
      const segments = parseSegments(opts.segment ?? []);

      // A video needs at least one driver. The server enforces per-model rules;
      // this just catches an entirely empty invocation early.
      if (
        !prompt &&
        segments.length === 0 &&
        !startImage &&
        refVideos.length === 0
      ) {
        throw new CliError(
          "Provide a prompt, --segment (multi-prompt), or --start-image.",
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
          opts.seed
        ) {
          throw new CliError(
            `${opts.model} does not support --start-image, --end-image, --ref-audio, --segment, --ar, --negative, --camera-fixed, or --seed in video-edit mode. Use --ref for supported reference images.`,
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
          session_id: opts.session,
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
          opts.resolution
        ) {
          throw new CliError(
            `${opts.model} does not support --end-image, --ref, --ref-audio, --segment, --ar, --negative, --camera-fixed, --seed, or --resolution in motion-control mode.`,
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
        toolArgs = {
          model: opts.model,
          prompt: prompt || undefined,
          image_url: startImage,
          motion_video_url: refVideos[0],
          quality: opts.quality,
          keep_original_sound: opts.audio,
          duration_seconds: duration,
          project_id: opts.project,
          session_id: opts.session,
          scene_index:
            opts.scene !== undefined ? Number(opts.scene) : undefined,
          shot_index: opts.shot !== undefined ? Number(opts.shot) : undefined,
        };
      } else {
        toolArgs = {
          prompt: prompt || undefined,
          model: opts.model,
          aspect_ratio: opts.ar,
          duration_seconds: duration,
          resolution: opts.resolution,
          quality: opts.quality,
          generate_audio: opts.audio,
          start_image_url: startImage,
          end_image_url: endImage,
          reference_images: refs.length > 0 ? refs : undefined,
          reference_videos: refVideos.length > 0 ? refVideos : undefined,
          reference_audio: refAudios.length > 0 ? refAudios : undefined,
          multi_prompt: segments.length > 0 ? segments : undefined,
          negative_prompt: opts.negative,
          camera_fixed: opts.cameraFixed ? true : undefined,
          seed,
          project_id: opts.project,
          session_id: opts.session,
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
    .option("--session <id>", "AI Studio session id")
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
        session_id: opts.session,
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
    .option("--session <id>", "AI Studio session id")
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
          session_id: opts.session,
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
          for (const f of downloaded ?? [])
            note(o, fmt.dim(o, savedLine(f)));
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
    .option("--session <id>", "AI Studio session id")
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
          session_id: opts.session,
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
          for (const f of downloaded ?? [])
            note(o, fmt.dim(o, savedLine(f)));
        },
      );
    });

  generate
    .command("sound-effect <prompt...>")
    .description("Generate a sound effect (ElevenLabs Sound Effects)")
    .option("--duration <seconds>", "length 0.5–22s (default 5)")
    .option("--influence <0-1>", "prompt influence (default 0.3)")
    .option("--project <id>", "link to a project's AI Studio session")
    .option("--session <id>", "AI Studio session id")
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
          session_id: opts.session,
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
          for (const f of downloaded ?? [])
            note(o, fmt.dim(o, savedLine(f)));
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
    .option("--session <id>", "AI Studio session id")
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
          session_id: opts.session,
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
          for (const f of downloaded ?? [])
            note(o, fmt.dim(o, savedLine(f)));
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
    .option("--session <id>", "AI Studio session id")
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
          session_id: opts.session,
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
          for (const f of downloaded ?? [])
            note(o, fmt.dim(o, savedLine(f)));
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
    .option("--session <id>", "AI Studio session id")
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
          session_id: opts.session,
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
          for (const f of downloaded ?? [])
            note(o, fmt.dim(o, savedLine(f)));
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
    .option("--session <id>", "AI Studio session id")
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
          session_id: opts.session,
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
          for (const f of downloaded ?? [])
            note(o, fmt.dim(o, savedLine(f)));
        },
      );
    });

  upscale
    .command("video <url|file>")
    .description(
      "Enhance or upscale an existing video with Topaz (async; waits by default)",
    )
    .option("--scale <factor>", 'e.g. "2x" (default)')
    .option("--session <id>", "AI Studio session id")
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
          session_id: opts.session,
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
