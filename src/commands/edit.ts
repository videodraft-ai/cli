/** `videodraft edit ...` specialized existing-media transformations. */

import type { Command } from "commander";
import { buildContext, compact } from "../cli/context.js";
import { capture } from "../cli/telemetry.js";
import { emit } from "../cli/output.js";
import { UsageError } from "../core/errors.js";
import { handleAsyncJob, resolveRefs } from "./generate.js";

const VIDEO_EDIT_MODELS = new Set([
  "happy-horse-video-edit",
  "kling-o3-video-ref-edit",
  "grok-imagine-video-edit",
  "wan-2.7-ref-edit",
]);

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

function chooseEditModel(
  explicit: string | undefined,
  refCount: number,
): string {
  if (explicit) {
    if (!VIDEO_EDIT_MODELS.has(explicit)) {
      throw new UsageError(
        `Unsupported video edit model "${explicit}". Run videodraft models video and use a video_edit entry.`,
      );
    }
    return explicit;
  }
  if (refCount > 1) return "happy-horse-video-edit";
  if (refCount === 1) return "wan-2.7-ref-edit";
  return "grok-imagine-video-edit";
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
      "happy-horse-video-edit | kling-o3-video-ref-edit | grok-imagine-video-edit | wan-2.7-ref-edit",
    )
    .option("--ref <url|file>", "reference image (repeatable)", collect, [])
    .option("--resolution <res>", "model-specific output resolution")
    .option("--quality <tier>", "Kling O3 only: standard or pro")
    .option(
      "--duration <seconds>",
      "Wan 2.7 only: 2-10s; other edit models follow the source/model duration",
    )
    .option("--preserve-audio", "preserve original source audio when supported")
    .option("--project <id>", "group in a project's AI Studio session")
    .option("--session <id>", "AI Studio session id")
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
      const model = chooseEditModel(opts.model, (opts.ref ?? []).length);
      const duration = positiveNumber(opts.duration, "--duration");
      const sceneIndex = nonNegativeInteger(opts.scene, "--scene");
      const shotIndex = nonNegativeInteger(opts.shot, "--shot");
      const refCount = (opts.ref ?? []).length;
      const maxRefs =
        model === "happy-horse-video-edit"
          ? 5
          : model === "kling-o3-video-ref-edit"
            ? 4
            : model === "wan-2.7-ref-edit"
              ? 1
              : 0;
      if (refCount > maxRefs) {
        throw new UsageError(
          `${model} accepts at most ${maxRefs} reference images.`,
        );
      }
      if (opts.quality && model !== "kling-o3-video-ref-edit") {
        throw new UsageError(
          "--quality applies only to kling-o3-video-ref-edit.",
        );
      }
      if (opts.quality && !["standard", "pro"].includes(opts.quality)) {
        throw new UsageError('--quality must be "standard" or "pro".');
      }
      if (opts.preserveAudio && model === "grok-imagine-video-edit") {
        throw new UsageError(
          "grok-imagine-video-edit does not expose source-audio preservation.",
        );
      }

      if (opts.estimate) {
        const estimate = await ctx.client.callTool(
          "get_model_costs",
          compact({
            model_id: model,
            type: "video",
            duration_seconds: duration,
            resolution: opts.resolution,
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
      if (duration !== undefined && model !== "wan-2.7-ref-edit") {
        throw new UsageError(
          `--duration is only controllable for wan-2.7-ref-edit. ${model} follows its source/model duration.`,
        );
      }

      const [[videoUrl], referenceImages] = await Promise.all([
        resolveRefs(ctx, [videoSource]),
        resolveRefs(ctx, opts.ref ?? []),
      ]);
      capture("cli_edit", { kind: "video", model, wait: opts.wait !== false });
      const submitted = await ctx.client.callTool(
        "edit_video",
        compact({
          model,
          prompt: promptWords.join(" ").trim(),
          video_url: videoUrl,
          reference_images:
            referenceImages.length > 0 ? referenceImages : undefined,
          resolution: opts.resolution,
          quality: opts.quality,
          duration_seconds: duration,
          preserve_audio: opts.preserveAudio ? true : undefined,
          project_id: opts.project,
          session_id: opts.session,
          scene_index: sceneIndex,
          shot_index: shotIndex,
        }),
      );
      await handleAsyncJob(ctx, submitted, {
        wait: opts.wait !== false,
        download: opts.download,
        label: `Editing video with ${model}`,
      });
    });

  edit
    .command("motion <image_url_or_file> <prompt...>")
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
    .option("--duration <seconds>", "optional estimate hint")
    .option("--project <id>", "group in a project's AI Studio session")
    .option("--session <id>", "AI Studio session id")
    .option("--scene <n>", "0-based scene index")
    .option("--shot <n>", "0-based shot index")
    .option("--download <path>", "download the finished video")
    .option("--no-wait", "submit and return the job id immediately")
    .option("--estimate", "print the cost estimate and exit")
    .action(async function (
      this: Command,
      imageSource: string,
      promptWords: string[],
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

      const [[imageUrl], [motionVideoUrl]] = await Promise.all([
        resolveRefs(ctx, [imageSource]),
        resolveRefs(ctx, [opts.motionVideo]),
      ]);
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
          character_orientation: opts.orientation,
          keep_original_sound: opts.originalSound !== false,
          project_id: opts.project,
          session_id: opts.session,
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
