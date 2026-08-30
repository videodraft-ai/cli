/** `videodraft edit ...` specialized existing-media transformations. */

import type { Command } from "commander";
import { buildContext, compact, sessionArg } from "../cli/context.js";
import { capture } from "../cli/telemetry.js";
import { emit, note, table } from "../cli/output.js";
import { EXIT, UsageError } from "../core/errors.js";
import {
  handleAsyncJob,
  normalizeGeminiOmniResolutionOption,
  parseKlingElements,
  resolveKlingElements,
  resolveRefs,
} from "./generate.js";

const VIDEO_EDIT_MODELS = new Set([
  "gemini-omni-1.1-flash",
  "happy-horse-video-edit",
  "kling-o3-video-ref-edit",
  "grok-imagine-video-edit",
]);

/** Reference-image cap per edit model; mirrors the server's own limits. */
const EDIT_MODEL_MAX_REFS: Record<string, number> = {
  "gemini-omni-1.1-flash": 10,
  "happy-horse-video-edit": 5,
  "kling-o3-video-ref-edit": 4,
  "grok-imagine-video-edit": 0,
};

/**
 * Priced cost lookups need a concrete id, so --estimate without --model quotes
 * the preferred edit model. Runtime submission stays model-less on purpose so
 * the SERVER makes the choice: it can measure the source duration, which the
 * CLI cannot, and it returns a priced menu when no model is safe to assume.
 */
const ESTIMATE_FALLBACK_EDIT_MODEL = "gemini-omni-1.1-flash";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function positiveNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${label} must be a positive number.`);
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

/**
 * Validate an explicitly named edit model, or return undefined so the server
 * chooses.
 *
 * This deliberately does NOT pick a model. The old ladder here mapped "one
 * --ref" to Wan 2.7 and "no --ref" to Grok, which meant the reference-image
 * COUNT silently selected the model and the user never saw it happen. The
 * server picks now: it measures the source, prefers Gemini Omni 1.1 Flash, and
 * returns a priced choice payload rather than guessing.
 */
function validateEditModel(explicit: string | undefined): string | undefined {
  if (!explicit) return undefined;
  if (!VIDEO_EDIT_MODELS.has(explicit)) {
    throw new UsageError(
      `Unsupported video edit model "${explicit}". Run videodraft models video --category video_edit and use one of those ids.`,
    );
  }
  return explicit;
}

export function registerEditCommands(program: Command): void {
  const edit = program
    .command("edit")
    .description("Edit or motion-transfer existing video media");

  edit
    .command("video <video_url_or_file> <prompt...>")
    .description("Edit an existing video with a dedicated video-edit model")
    .option(
      "--model <id>",
      "gemini-omni-1.1-flash (preferred, auto-selected for sources up to 10s) | grok-imagine-video-edit | kling-o3-video-ref-edit | happy-horse-video-edit",
    )
    .option("--ref <url|file>", "reference image (repeatable)", collect, [])
    .option(
      "--ref-video <url|file>",
      "deprecated: Gemini Omni 1.1 Flash edits accept exactly one input video, so a creative reference video cannot accompany the source",
      collect,
      [],
    )
    .option(
      "--ref-video-duration <seconds>",
      "measured duration matching each creative --ref-video (repeatable; usually auto-measured)",
      collect,
      [],
    )
    .option("--resolution <res>", "model-specific output resolution")
    .option("--quality <tier>", "Kling O3 only: standard or pro")
    .option(
      "--duration <seconds>",
      "estimate-only output duration; submitted edits follow the source/model duration",
    )
    .option("--preserve-audio", "preserve original source audio when supported")
    .option("--project <id>", "group in a project's AI Studio session")
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--scene <n>", "0-based scene index")
    .option("--shot <n>", "0-based shot index")
    .option("--download <path>", "download the finished video")
    .option("--no-wait", "submit and return the job id immediately")
    .option("--estimate", "print the cost estimate and exit")
    .action(async function (
      this: Command,
      videoSource: string,
      promptWords: string[],
    ) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const model = validateEditModel(opts.model);
      const duration = positiveNumber(opts.duration, "--duration");
      const sceneIndex = nonNegativeInteger(opts.scene, "--scene");
      const shotIndex = nonNegativeInteger(opts.shot, "--shot");
      const refCount = (opts.ref ?? []).length;
      const refVideoCount = (opts.refVideo ?? []).length;
      const referenceVideoDurations = (opts.refVideoDuration ?? []).map(
        (raw: string) => Number(raw),
      );
      // With no --model the server picks, so only reject a count no edit model
      // could accept; the server enforces the exact per-model cap after it
      // chooses.
      const maxRefs = model
        ? (EDIT_MODEL_MAX_REFS[model] ?? 0)
        : Math.max(...Object.values(EDIT_MODEL_MAX_REFS));
      if (refCount > maxRefs) {
        throw new UsageError(
          model
            ? `${model} accepts at most ${maxRefs} reference images.`
            : `No video edit model accepts more than ${maxRefs} reference images.`,
        );
      }
      // Google accepts exactly one input video for an edit, so a creative
      // reference can never accompany the source `edit video` always supplies.
      // gemini-omni was the only model that took --ref-video here, so the flag
      // now has no valid use; keep it so old scripts get this message rather
      // than "unknown option", and rather than a provider 400 mid-generation.
      if (refVideoCount > 0) {
        throw new UsageError(
          "gemini-omni-1.1-flash accepts exactly one input video for an edit, so --ref-video cannot accompany the source. Drop the references, or use `generate video --video-task generate` to guide a new clip with them.",
        );
      }
      if (
        referenceVideoDurations.length > 0 &&
        referenceVideoDurations.length !== refVideoCount
      ) {
        throw new UsageError(
          "Repeat --ref-video-duration once for each --ref-video.",
        );
      }
      if (
        referenceVideoDurations.some(
          (seconds: number) =>
            !Number.isFinite(seconds) || seconds <= 0 || seconds > 3,
        )
      ) {
        throw new UsageError(
          "Each --ref-video-duration must be greater than 0 and at most 3 seconds.",
        );
      }
      if (opts.quality && model !== "kling-o3-video-ref-edit") {
        throw new UsageError(
          model
            ? "--quality applies only to kling-o3-video-ref-edit."
            : "--quality applies only to kling-o3-video-ref-edit. Pass --model kling-o3-video-ref-edit to use it.",
        );
      }
      if (opts.quality && !["standard", "pro"].includes(opts.quality)) {
        throw new UsageError('--quality must be "standard" or "pro".');
      }
      if (
        model === "gemini-omni-1.1-flash" &&
        opts.resolution &&
        !normalizeGeminiOmniResolutionOption(opts.resolution)
      ) {
        throw new UsageError(
          'gemini-omni-1.1-flash --resolution must be "360p", "720p", "1080p", or "4k".',
        );
      }
      if (
        (!model || model === "gemini-omni-1.1-flash") &&
        opts.resolution
      ) {
        const normalizedResolution = normalizeGeminiOmniResolutionOption(
          opts.resolution,
        );
        if (normalizedResolution) opts.resolution = normalizedResolution;
      }
      if (
        opts.preserveAudio &&
        (model === "grok-imagine-video-edit" || model === "gemini-omni-1.1-flash")
      ) {
        throw new UsageError(
          `${model} does not expose source-audio preservation.`,
        );
      }

      if (opts.estimate) {
        const estimateModel = model ?? ESTIMATE_FALLBACK_EDIT_MODEL;
        const estimate = await ctx.client.callTool(
          "get_model_costs",
          compact({
            model_id: estimateModel,
            type: "video",
            duration_seconds: duration,
            resolution: opts.resolution,
            quality: opts.quality,
          }),
        );
        emit(ctx.out, {
          estimate,
          model: estimateModel,
          model_assumed: model === undefined,
          note:
            model === undefined
              ? `No credits were spent (--estimate). Quoted with ${estimateModel}, the preferred edit model; the server picks the real model at submit time and returns a priced menu when this one cannot run the source.`
              : "No credits were spent (--estimate).",
        });
        return;
      }
      if (duration !== undefined) {
        throw new UsageError(
          "--duration is estimate-only for video edits. Submitted edits follow the source and model duration.",
        );
      }
      const [[videoUrl], referenceImages, referenceVideos] = await Promise.all([
        resolveRefs(ctx, [videoSource]),
        resolveRefs(ctx, opts.ref ?? []),
        resolveRefs(ctx, opts.refVideo ?? []),
      ]);
      capture("cli_edit", {
        kind: "video",
        model: model ?? "auto",
        wait: opts.wait !== false,
      });
      const submitted = await ctx.client.callTool(
        "edit_video",
        compact({
          model,
          prompt: promptWords.join(" ").trim(),
          video_url: videoUrl,
          reference_images:
            referenceImages.length > 0 ? referenceImages : undefined,
          reference_videos:
            referenceVideos.length > 0 ? referenceVideos : undefined,
          reference_video_durations:
            referenceVideoDurations.length > 0
              ? referenceVideoDurations
              : undefined,
          resolution: opts.resolution,
          quality: opts.quality,
          preserve_audio: opts.preserveAudio ? true : undefined,
          project_id: opts.project,
          session_id: sessionArg(this, opts),
          scene_index: sceneIndex,
          shot_index: shotIndex,
        }),
      );
      // The server could not safely assume a model (source longer than the
      // preferred model's 10s ceiling, unmeasurable duration, or a BYOK/limit
      // conflict). Nothing was spent: print the priced menu and exit 2 so the
      // caller re-runs with --model. Emitting instead of throwing keeps --json
      // to exactly one document on stdout.
      const choice = submitted as any;
      if (choice?.status === "needs_model_choice") {
        emit(ctx.out, choice, (o) => {
          note(o, choice.message);
          const rows: string[][] = (choice.options ?? []).map((opt: any) => [
            String(opt.model ?? ""),
            opt.edited_seconds === null ? "?" : `${opt.edited_seconds}s`,
            opt.dropped_seconds === null ? "?" : `${opt.dropped_seconds}s`,
            opt.credits_estimate === null
              ? "n/a"
              : String(opt.credits_estimate),
            String(opt.max_reference_images ?? ""),
            String(opt.max_reference_videos ?? ""),
          ]);
          table(
            o,
            ["model", "edits", "drops", "credits", "img refs", "vid refs"],
            rows,
          );
          if (choice.chunked_option?.chunks) {
            note(
              o,
              `Full length: ${choice.chunked_option.chunks} x <=10s Gemini edits reassembled in the native editor, about ${choice.chunked_option.credits_estimate} credits. ${choice.chunked_option.caveat}`,
            );
          }
          note(o, "Re-run with --model <id>. No credits were spent.");
        });
        process.exitCode = EXIT.USAGE;
        return;
      }

      if (choice?.source?.truncated) {
        note(
          ctx.out,
          `Heads up: ${choice.model} edits at most ${choice.source.edited_seconds}s of this ${choice.source.source_seconds}s source. ${choice.source.dropped_seconds}s will not appear in the result.`,
        );
      }

      await handleAsyncJob(ctx, submitted, {
        wait: opts.wait !== false,
        download: opts.download,
        label: `Editing video with ${choice?.model ?? model ?? "the selected model"}`,
      });
    });

  edit
    .command("motion <image_url_or_file> [prompt...]")
    .description("Transfer motion from a reference video onto a subject image")
    .requiredOption("--motion-video <url|file>", "motion reference video")
    .option(
      "--model <id>",
      "kling-v3-motion-control (default) | kling-2.6-motion-control",
    )
    .option("--quality <tier>", "standard or pro (default pro)")
    .option(
      "--orientation <mode>",
      "video (30s cap) or image (10s cap); defaults to the model setting",
    )
    .option("--no-original-sound", "remove sound from the motion reference")
    .option(
      "--element <json|@file>",
      'Kling V3 facial identity element, e.g. \'{"frontal_image_url":"face.png","reference_image_urls":["profile.png"]}\'',
    )
    .option("--duration <seconds>", "optional estimate hint")
    .option("--project <id>", "group in a project's AI Studio session")
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: the current connection scope; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--scene <n>", "0-based scene index")
    .option("--shot <n>", "0-based shot index")
    .option("--download <path>", "download the finished video")
    .option("--no-wait", "submit and return the job id immediately")
    .option("--estimate", "print the cost estimate and exit")
    .action(async function (
      this: Command,
      imageSource: string,
      promptWords: string[] = [],
    ) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const model = opts.model ?? "kling-v3-motion-control";
      if (
        model !== "kling-v3-motion-control" &&
        model !== "kling-2.6-motion-control"
      ) {
        throw new UsageError(
          `Unsupported motion-control model "${model}". Run videodraft models video and use a motion_control entry.`,
        );
      }
      const duration = positiveNumber(opts.duration, "--duration");
      const sceneIndex = nonNegativeInteger(opts.scene, "--scene");
      const shotIndex = nonNegativeInteger(opts.shot, "--shot");
      if (opts.quality && !["standard", "pro"].includes(opts.quality)) {
        throw new UsageError('--quality must be "standard" or "pro".');
      }
      if (opts.orientation && !["image", "video"].includes(opts.orientation)) {
        throw new UsageError('--orientation must be "image" or "video".');
      }
      const rawElements = parseKlingElements(
        opts.element ? [opts.element] : [],
      );
      if (rawElements.length > 0) {
        const element = rawElements[0];
        if (model !== "kling-v3-motion-control") {
          throw new UsageError(
            "--element is supported only by kling-v3-motion-control.",
          );
        }
        if (
          rawElements.length !== 1 ||
          !element ||
          !element.frontal_image_url ||
          (element.reference_image_urls?.length ?? 0) === 0 ||
          element.video_url ||
          element.voice_id
        ) {
          throw new UsageError(
            "Motion control accepts one image-only --element with frontal_image_url and 1-3 reference_image_urls.",
          );
        }
        if (opts.orientation === "image") {
          throw new UsageError(
            '--element requires --orientation video. Omit --orientation to select "video" automatically.',
          );
        }
      }
      if (opts.estimate) {
        const estimate = await ctx.client.callTool(
          "get_model_costs",
          compact({
            model_id: model,
            type: "video",
            duration_seconds: duration,
            quality: opts.quality,
          }),
        );
        emit(ctx.out, {
          estimate,
          model,
          note: "No credits were spent (--estimate).",
        });
        return;
      }
      if (duration !== undefined) {
        throw new UsageError(
          "--duration is estimate-only for motion control. Output duration follows the motion video and orientation cap.",
        );
      }

      const [[imageUrl], [motionVideoUrl], elements] = await Promise.all([
        resolveRefs(ctx, [imageSource]),
        resolveRefs(ctx, [opts.motionVideo]),
        resolveKlingElements(ctx, rawElements),
      ]);
      const resolvedElement = elements[0];
      capture("cli_edit", {
        kind: "motion_control",
        model,
        wait: opts.wait !== false,
      });
      const submitted = await ctx.client.callTool(
        "generate_motion_control_video",
        compact({
          model,
          prompt: promptWords.join(" ").trim(),
          image_url: imageUrl,
          motion_video_url: motionVideoUrl,
          quality: opts.quality,
          character_orientation:
            elements.length > 0 ? "video" : opts.orientation,
          keep_original_sound: opts.originalSound !== false,
          element: resolvedElement
            ? {
                frontal_image_url: resolvedElement.frontal_image_url,
                reference_image_urls: resolvedElement.reference_image_urls,
              }
            : undefined,
          project_id: opts.project,
          session_id: sessionArg(this, opts),
          scene_index: sceneIndex,
          shot_index: shotIndex,
        }),
      );
      await handleAsyncJob(ctx, submitted, {
        wait: opts.wait !== false,
        download: opts.download,
        label: `Generating motion control with ${model}`,
      });
    });
}
