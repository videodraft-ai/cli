/**
 * The project pipeline: create (idea → storyboard project), shots, produce,
 * export. Mirrors the canonical MCP flow:
 *   generate_storyboard_from_idea → generate_shot_images → produce_project → export_video
 */

import type { Command } from "commander";
import { buildContext, compact } from "../cli/context.js";
import { emit, fmt, note, spinner } from "../cli/output.js";
import { extractOutputUrls, pollGenerationsBatch, pollExport } from "../core/poll.js";
import { buildMediaDescriptors } from "../core/media.js";
import { downloadOutputs, type DownloadedFile } from "../core/download.js";
import { uploadFile } from "../core/upload.js";
import { capture } from "../cli/telemetry.js";
import { CliError, EXIT } from "../core/errors.js";

/** URL passes through; a bare local path is uploaded to the CDN first. */
async function resolveMedia(ctx: { client: any; out: any }, src: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) return src;
  const uploaded = await uploadFile(ctx.client, src);
  return uploaded.url;
}

export function registerPipelineCommands(program: Command): void {
  program
    .command("create <idea...>")
    .description("Create a storyboard project from an idea (script → assets → storyboard)")
    .option("--title <title>", "project title")
    .option("--duration <length>", "short | medium | long | auto")
    .option("--style <style>", 'style preset id, or "custom:<description>"')
    .option("--mood <mood>", "mood hint")
    .option("--ar <ratio>", 'aspect ratio, e.g. "16:9", "9:16"')
    .option("--project <id>", "build into an existing project instead of creating one")
    .option("--image-model <id>", "image model for visual-asset images")
    .option("--no-asset-images", "skip generating visual-asset reference images")
    .option("--shots", "also batch-generate every shot image (spends credits per shot)")
    .option("--grid", "with --shots: grid mode for stronger cross-shot consistency")
    .option("--script-only", "stop at the script (script-stage project, no storyboard)")
    .action(async function (this: Command, ideaWords: string[]) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const idea = ideaWords.join(" ");

      capture("cli_create", { script_only: Boolean(opts.scriptOnly), shots: Boolean(opts.shots) });
      const tool = opts.scriptOnly ? "generate_script_from_idea" : "generate_storyboard_from_idea";
      const spin = spinner(
        ctx.out,
        opts.scriptOnly ? "Generating script…" : "Building project (script → assets → storyboard)…",
      );
      let result: any;
      try {
        result = await ctx.client.callTool(
          tool,
          compact({
            idea,
            title: opts.title,
            duration: opts.duration,
            style: opts.style,
            mood: opts.mood,
            aspect_ratio: opts.scriptOnly ? undefined : opts.ar,
            project_id: opts.project,
            image_model: opts.scriptOnly ? undefined : opts.imageModel,
            generate_asset_images: opts.scriptOnly ? undefined : opts.assetImages,
            generate_shot_images: opts.scriptOnly ? undefined : opts.shots || undefined,
            grid: opts.scriptOnly ? undefined : opts.grid || undefined,
          }),
        );
      } catch (err: any) {
        // The pipeline runs several model steps; a transport timeout does NOT
        // mean the project wasn't created server-side. Re-creating would
        // duplicate it — point at the resume path instead.
        if (err?.name === "TimeoutError" || /timed? ?out|abort/i.test(String(err?.message))) {
          throw new CliError(
            "The request timed out, but the project was likely still created server-side.",
            EXIT.ERROR,
            "Run `videodraft projects list`, take the most recent project, and resume with `videodraft create ... --project <id>` (or continue with `videodraft shots <id>`). Do not re-run create from scratch.",
          );
        }
        throw err;
      } finally {
        spin.stop();
      }

      emit(ctx.out, result, (o) => {
        note(o, fmt.green(o, `Project ${result?.project_id ?? "created"}.`));
        if (result?.urls?.storyboard) note(o, `  ${result.urls.storyboard}`);
        if (result?.summary) note(o, fmt.dim(o, String(result.summary).slice(0, 400)));
        const shotJobs: string[] = result?.shot_image_job_ids ?? [];
        if (shotJobs.length > 0) {
          note(o, fmt.dim(o, `Shot image jobs: ${shotJobs.join(", ")} — poll with videodraft status <job>`));
        }
      });
    });

  program
    .command("shots <project_id>")
    .description("Batch-generate the storyboard shot images (spends credits per shot)")
    .option("--scene <n>", "0-based scene index (omit for all scenes)")
    .option("--model <id>", "image model id")
    .option("--ar <ratio>", "aspect ratio override")
    .option("--grid", "grid mode (stronger cross-shot consistency)")
    .option("--regenerate-all", "replace existing shot images too")
    .option("--no-wait", "submit and return job ids immediately")
    .option("--estimate", "estimate the cost and exit (spends nothing)")
    .action(async function (this: Command, projectId: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();

      if (opts.estimate) {
        const project: any = await ctx.client.callTool("get_project", {
          project_id: projectId,
          view: "summary",
        });
        const costs = await ctx.client.callTool(
          "get_model_costs",
          compact({ model_id: opts.model, type: "image" }),
        );
        emit(ctx.out, {
          project_scenes: project?.storyboard?.scenes?.length ?? project?.scenes?.length,
          per_image_costs: costs,
          note: "Total ≈ shots missing images × per-image cost (+1 grid image per scene in grid mode). No credits were spent.",
        });
        return;
      }

      capture("cli_shots", { grid: Boolean(opts.grid) });
      const submitted: any = await ctx.client.callTool(
        "generate_shot_images",
        compact({
          project_id: projectId,
          scene_index: opts.scene !== undefined ? Number(opts.scene) : undefined,
          model: opts.model,
          aspect_ratio: opts.ar,
          grid: opts.grid || undefined,
          regenerate_all: opts.regenerateAll || undefined,
        }),
      );
      const jobIds: string[] = submitted?.job_ids ?? (submitted?.job_id ? [submitted.job_id] : []);
      if (opts.wait === false || jobIds.length === 0) {
        emit(ctx.out, submitted, (o) => {
          note(o, `Submitted ${jobIds.length || "?"} job(s).`);
          for (const id of jobIds) note(o, fmt.dim(o, `  videodraft status ${id}`));
        });
        return;
      }
      const spin = spinner(ctx.out, `Generating shot images (${jobIds.length} job(s))…`);
      try {
        const resultMap = await pollGenerationsBatch(ctx.client, jobIds, {
          intervalMs: ctx.intervalMs,
          timeoutMs: ctx.timeoutMs,
          adaptive: ctx.adaptive,
          onTick: (progress) => spin.update(`Generating shot images — ${progress}`),
        });
        const results = jobIds.map((id) => resultMap.get(id)!);
        spin.stop();
        const failed = results.filter((r) => r.status === "failed").length;
        emit(
          ctx.out,
          {
            job_ids: jobIds,
            results: jobIds.map((jobId) => {
              const result = resultMap.get(jobId)!;
              return {
                job_id: jobId,
                status: result.status,
                outputs: result.outputUrls,
                output_media: buildMediaDescriptors(result.outputUrls, result.payload?.type),
              };
            }),
          },
          (o) => {
            note(
              o,
              failed === 0
                ? fmt.green(o, `All ${results.length} job(s) completed — images are on the shot cards.`)
                : fmt.red(o, `${failed}/${results.length} job(s) failed.`),
            );
          },
        );
        if (failed > 0) process.exitCode = 1;
      } catch (err) {
        spin.stop();
        throw err;
      }
    });

  program
    .command("produce <project_id>")
    .description("Produce the storyboard into production — animatic (default) or full_video AI Production")
    .option("--mode <mode>", 'animatic (slideshow, default) | full_video (one Seedance 2 video per scene)')
    .option("--no-auto-videos", "full_video: set up scene videos but don't submit them (no credits spent)")
    .option("--no-voiceover", "skip per-scene voiceovers + captions")
    .option("--no-video-prompts", "skip advisory per-shot motion prompts")
    .option("--shot-duration <seconds>", "per-shot clip length for silent/no-voiceover scenes (default 3)")
    .option("--voice <id>", "TTS voice id for voiceovers")
    .option("--language <bcp47>", "voiceover + caption language")
    .option("--captions", "force burn captions")
    .option("--no-captions", "force no captions (default follows voiceover)")
    .action(async function (this: Command, projectId: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      // Tri-state captions: only send when the user explicitly set --captions/--no-captions.
      const captionsSrc = this.getOptionValueSource("captions");
      capture("cli_produce", { mode: opts.mode ?? "animatic" });
      const spin = spinner(
        ctx.out,
        opts.mode === "full_video"
          ? "Producing (full_video: composing scenes → submitting Seedance videos)…"
          : "Producing project (voiceovers → captions → timeline)…",
      );
      let result: any;
      try {
        result = await ctx.client.callTool(
          "produce_project",
          compact({
            project_id: projectId,
            mode: opts.mode,
            // negatable flags default true; only forward an explicit opt-out.
            auto_generate_videos: opts.autoVideos === false ? false : undefined,
            include_voiceover: opts.voiceover === false ? false : undefined,
            generate_video_prompts: opts.videoPrompts === false ? false : undefined,
            shot_duration: opts.shotDuration ? Number(opts.shotDuration) : undefined,
            voice_id: opts.voice,
            language: opts.language,
            show_captions: captionsSrc === "cli" ? opts.captions : undefined,
          }),
        );
      } finally {
        spin.stop();
      }
      const pendingVideos: string[] = result?.pending_scene_video_generations ?? result?.pending_generation_ids ?? [];
      emit(ctx.out, result, (o) => {
        if (result?.status === "generating_shot_images") {
          note(o, fmt.yellow(o, "Shot images are still generating — poll the job ids below, then re-run produce."));
          for (const id of result?.shot_image_job_ids ?? result?.job_ids ?? [])
            note(o, fmt.dim(o, `  videodraft status ${id}`));
        } else if (opts.mode === "full_video" && pendingVideos.length > 0) {
          note(o, fmt.green(o, `Producing ${pendingVideos.length} scene video(s).`));
          note(o, fmt.dim(o, "Poll: videodraft generations  → then: videodraft finalize " + projectId + " → videodraft export " + projectId));
        } else {
          note(o, fmt.green(o, "Produced. Next: videodraft export " + projectId));
        }
      });
    });

  program
    .command("finalize <project_id>")
    .description("Swap completed full_video scene videos into the timeline (after produce --mode full_video)")
    .action(async function (this: Command, projectId: string) {
      const ctx = buildContext(this);
      const result: any = await ctx.client.callTool("finalize_scene_videos", { project_id: projectId });
      emit(ctx.out, result, (o) => {
        note(
          o,
          fmt.green(
            o,
            `Finalized ${result?.finalized ?? 0}, failed ${result?.failed ?? 0}, still pending ${result?.still_pending ?? result?.pending_remaining ?? 0}.`,
          ),
        );
        if ((result?.pending_remaining ?? result?.still_pending ?? 0) > 0) {
          note(o, fmt.dim(o, "Some clips are still rendering — re-run finalize later (it's idempotent)."));
        }
      });
    });

  program
    .command("attach <project_id>")
    .description("Place a clip/image onto a storyboard shot (e.g. a generated video into the timeline)")
    .requiredOption("--scene <n>", "0-based scene index")
    .requiredOption("--shot <n>", "0-based shot index")
    .requiredOption("--media <url|file>", "media to attach (local files are uploaded)")
    .option("--type <type>", "image | video (default image)")
    .option("--duration <seconds>", "clip duration in seconds (recommended for video)")
    .option("--thumbnail <url|file>", "optional thumbnail")
    .action(async function (this: Command, projectId: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const [mediaUrl, thumbUrl] = await Promise.all([
        resolveMedia(ctx, opts.media),
        opts.thumbnail ? resolveMedia(ctx, opts.thumbnail) : undefined,
      ]);
      capture("cli_attach", { type: opts.type ?? "image" });
      const result = await ctx.client.callTool(
        "attach_media_to_shot",
        compact({
          project_id: projectId,
          scene_index: Number(opts.scene),
          shot_index: Number(opts.shot),
          media_url: mediaUrl,
          thumbnail_url: thumbUrl,
          media_type: opts.type,
          duration_seconds: opts.duration ? Number(opts.duration) : undefined,
        }),
      );
      emit(ctx.out, result, (o) => note(o, fmt.green(o, `Attached to scene ${opts.scene}, shot ${opts.shot}.`)));
    });

  program
    .command("export <project_id>")
    .description("Render the final MP4 (project must be produced)")
    .option("--captions", "burn captions into the render")
    .option("--no-captions", "render without captions")
    .option("--download <path>", "download the MP4 when finished")
    .option("--no-wait", "start the export and return the export id")
    .action(async function (this: Command, projectId: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      capture("cli_export");
      const started: any = await ctx.client.callTool(
        "export_video",
        compact({ project_id: projectId, show_captions: opts.captions }),
      );
      const exportId: string | undefined = started?.export_id;
      if (opts.wait === false) {
        emit(ctx.out, started, (o) => {
          note(o, `Export started${exportId ? ` — ${exportId}` : ""}.`);
          note(o, fmt.dim(o, `Check with: videodraft export-status ${exportId ?? projectId}`));
        });
        return;
      }
      const spin = spinner(ctx.out, "Rendering MP4…");
      try {
        const result = await pollExport(
          ctx.client,
          { exportId, projectId },
          {
            intervalMs: Math.max(ctx.intervalMs, 5_000),
            timeoutMs: Math.max(ctx.timeoutMs, 1_200_000),
            adaptive: ctx.adaptive,
            onTick: (status) => spin.update(`Rendering MP4 — ${status}`),
          },
        );
        spin.stop();
        if (result.status === "failed" || !result.videoUrl) {
          emit(ctx.out, result.payload, (o) => note(o, fmt.red(o, "Export failed.")));
          process.exitCode = 1;
          return;
        }
        let downloaded: DownloadedFile[] | undefined;
        if (opts.download) {
          downloaded = await downloadOutputs([result.videoUrl], opts.download, {
            job_id: exportId ?? projectId,
            name: "export",
          });
        }
        const media = buildMediaDescriptors([result.videoUrl], "video");
        emit(
          ctx.out,
          { export_id: exportId, video_url: result.videoUrl, downloaded_files: downloaded, output_media: media },
          (o) => {
            note(o, fmt.green(o, "Export finished."));
            process.stdout.write(`${result.videoUrl}\n`);
            for (const f of downloaded ?? []) note(o, fmt.dim(o, `saved ${f.path}`));
          },
        );
      } catch (err) {
        spin.stop();
        throw err;
      }
    });

  program
    .command("export-status <id>")
    .description("Check a video export — pass the export_id (or --project to pass a project id)")
    .option("--project", "treat <id> as a project id (checks its latest export)")
    .option("--wait <seconds>", "block up to N seconds (max 240), re-polling until terminal")
    .action(async function (this: Command, ref: string) {
      const ctx = buildContext(this);
      const opts = this.opts<{ project?: boolean; wait?: string }>();
      const result = await ctx.client.callTool(
        "check_export_status",
        compact({
          export_id: opts.project ? undefined : ref,
          project_id: opts.project ? ref : undefined,
          wait_seconds: opts.wait ? Number(opts.wait) : undefined,
        }),
      );
      const media = buildMediaDescriptors(extractOutputUrls(result), "video");
      emit(ctx.out, { ...result, output_media: media });
    });

  program
    .command("video-prompts <project_id>")
    .description("Generate advisory per-shot motion/video prompts for a project")
    .option("--ar <ratio>", "aspect ratio")
    .option("--instructions <text>", "authoring instructions")
    .option("--has-voiceover", "tell the generator the project has a voiceover track")
    .option("--video-audio", "tell the generator that generated videos may include native audio")
    .option("--has-bgm", "tell the generator the project has background music")
    .action(async function (this: Command, projectId: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const result = await ctx.client.callTool(
        "generate_video_prompts",
        compact({
          project_id: projectId,
          aspect_ratio: opts.ar,
          instructions: opts.instructions,
          has_voiceover: opts.hasVoiceover || undefined,
          generate_video_audio: opts.videoAudio || undefined,
          has_background_music: opts.hasBgm || undefined,
        }),
      );
      emit(ctx.out, result);
    });
}
