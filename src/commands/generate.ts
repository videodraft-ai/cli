/**
 * `videodraft generate image|video|voiceover|music` and `videodraft upscale`.
 *
 * Conventions:
 *  - image/video are async server-side: submit → poll. We wait by default
 *    (spinner) and print/download outputs; --no-wait returns the job id.
 *  - --estimate prints the get_model_costs quote and exits without spending.
 *  - --ref accepts URLs or local file paths; local files are auto-uploaded
 *    via the create_media_upload flow before generating.
 */

import fs from "node:fs";
import type { Command } from "commander";
import { buildContext, collect, compact, type CommandContext } from "../cli/context.js";
import { emit, fmt, note, spinner } from "../cli/output.js";
import { pollGeneration, extractOutputUrls } from "../core/poll.js";
import { buildMediaDescriptors } from "../core/media.js";
import { downloadOutputs, type DownloadedFile } from "../core/download.js";
import { uploadFile } from "../core/upload.js";
import { capture } from "../cli/telemetry.js";
import { CliError, EXIT } from "../core/errors.js";

/** Any URI scheme (http(s), gs://, data:, …) passes through; a bare path is a local file. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Resolve reference inputs (images, videos, audio): pass URLs through, upload
 * local files to the CDN first. Unlike the raw MCP tool — which rejects local
 * video/audio paths — the CLI uploads them, so `--ref-video clip.mp4` works.
 */
async function resolveRefs(ctx: CommandContext, refs: string[]): Promise<string[]> {
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
export function parseSegments(values: string[]): Array<{ prompt: string; duration: number }> {
  return values.map((v) => {
    const i = v.lastIndexOf(":");
    if (i <= 0 || i === v.length - 1) {
      throw new CliError(`--segment expects "prompt:seconds", got: ${v}`, EXIT.USAGE);
    }
    const prompt = v.slice(0, i).trim();
    const duration = Number(v.slice(i + 1));
    if (!prompt || !Number.isFinite(duration) || duration <= 0) {
      throw new CliError(`--segment "${v}" must be "<prompt>:<positive seconds>".`, EXIT.USAGE);
    }
    return { prompt, duration };
  });
}

async function printEstimate(
  ctx: CommandContext,
  params: {
    model?: string;
    type: "image" | "video";
    duration?: number;
    resolution?: string;
    quality?: string;
    renderingSpeed?: string;
    audio?: boolean;
    num?: number;
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
      num_images: params.num,
    }),
  );
  emit(ctx.out, { estimate, note: "No credits were spent (--estimate)." });
}

interface SubmitWaitOptions {
  wait: boolean;
  download?: string;
  label: string;
}

/** Shared submit → poll → download tail for async generations. */
async function handleAsyncJob(
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
      onTick: (status) => spin.update(`${options.label} — ${status} (job ${jobId})`),
    });
    spin.stop();

    if (result.status === "failed") {
      emit(ctx.out, { job_id: jobId, ...result.payload }, (o) => {
        note(o, fmt.red(o, `Job ${jobId} failed: ${result.payload?.error ?? "unknown error"}`));
      });
      process.exitCode = 1;
      return;
    }

    let downloaded: DownloadedFile[] | undefined;
    if (options.download && result.outputUrls.length > 0) {
      downloaded = await downloadOutputs(result.outputUrls, options.download, { job_id: jobId });
    }
    const media = buildMediaDescriptors(result.outputUrls, result.payload?.type);
    emit(
      ctx.out,
      { job_id: jobId, status: result.status, outputs: result.outputUrls, downloaded_files: downloaded, output_media: media },
      (o) => {
        note(o, fmt.green(o, `Completed — job ${jobId}`));
        for (const url of result.outputUrls) process.stdout.write(`${url}\n`);
        for (const file of downloaded ?? []) note(o, fmt.dim(o, `saved ${file.path}`));
      },
    );
  } catch (err) {
    spin.stop();
    throw err;
  }
}

export function registerGenerateCommands(program: Command): void {
  const generate = program.command("generate").description("Generate images, video, voiceovers and music");

  generate
    .command("image <prompt...>")
    .description("Generate an image (async; waits by default)")
    .option("--model <id>", "image model id (default nano-banana-2)")
    .option("--ar <ratio>", 'aspect ratio, e.g. "16:9"')
    .option("--resolution <res>", 'e.g. "1K", "2K", "4K"')
    .option("--quality <tier>", "model-specific quality tier")
    .option("--rendering-speed <tier>", 'Ideogram speed/cost tier, e.g. V4 "Turbo"/"Balanced"/"Quality"')
    .option("--num <n>", "variations of this prompt in one call (1-4)")
    .option("--seed <n>", "seed (supported models only, e.g. Flux, Ideogram V4)")
    .option("--ref <url|file>", "reference image (repeatable; local files are uploaded)", collect, [])
    .option("--video-ref <url|file>", "video reference — nano-banana-2 only (http(s)/gs:///YouTube, or local file)")
    .option("--style <id>", "style preset id")
    .option("--project <id>", "attach to a project")
    .option("--session <id>", "AI Studio session id")
    .option("--scene <n>", "0-based scene index (with --project: writes onto that shot)")
    .option("--shot <n>", "0-based shot index")
    .option("--download <path>", "download outputs (template: {job_id} {index} {ext})")
    .option("--no-wait", "submit and return the job id immediately")
    .option("--estimate", "print the cost estimate and exit (spends nothing)")
    .action(async function (this: Command, promptWords: string[]) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const prompt = promptWords.join(" ");

      if (opts.estimate) {
        await printEstimate(ctx, {
          model: opts.model,
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
        opts.videoRef ? resolveRefs(ctx, [opts.videoRef]).then((r) => r[0]) : undefined,
      ]);
      capture("cli_generate", { kind: "image", model: opts.model ?? "default", wait: opts.wait !== false });
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
          scene_index: opts.scene !== undefined ? Number(opts.scene) : undefined,
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
    .description("Generate a video clip (async; per-second pricing — see --estimate)")
    .option("--model <id>", "video model id (default google-veo3.1 fast)")
    .option("--ar <ratio>", 'aspect ratio, e.g. "16:9", "9:16"')
    .option("--duration <seconds>", "clip duration in seconds")
    .option("--resolution <res>", 'e.g. "720p", "1080p"')
    .option("--quality <tier>", 'e.g. "fast", "quality", "standard", "pro"')
    .option("--audio", "generate native model audio")
    .option("--no-audio", "disable native model audio")
    .option("--start-image <url|file>", "start frame (image-to-video)")
    .option("--end-image <url|file>", "end frame (supported models only)")
    .option("--ref <url|file>", "reference image (repeatable)", collect, [])
    .option("--ref-video <url|file>", "reference video (repeatable; Seedance 2, Wan 2.7; local files uploaded)", collect, [])
    .option("--ref-audio <url|file>", "reference audio (repeatable; Seedance 2; local files uploaded)", collect, [])
    .option("--segment <prompt:seconds>", "multi-prompt segment (repeatable; Kling 3.0 / 3.0 Turbo / O3)", collect, [])
    .option("--negative <text>", "negative prompt (Kling/Wan/Luma)")
    .option("--seed <n>", "seed")
    .option("--project <id>", "attach to a project")
    .option("--session <id>", "AI Studio session id")
    .option("--scene <n>", "0-based scene index")
    .option("--shot <n>", "0-based shot index")
    .option("--download <path>", "download outputs (template: {job_id} {index} {ext})")
    .option("--no-wait", "submit and return the job id immediately")
    .option("--estimate", "print the cost estimate and exit (spends nothing)")
    .action(async function (this: Command, promptWords: string[] = []) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      // prompt is OPTIONAL: Kling 3.0 / 3.0 Turbo / O3 allow multi-prompt-only
      // calls, and Kling 3.0 Turbo allows image-to-video with no prompt.
      const prompt = promptWords.join(" ").trim();
      const duration = opts.duration ? Number(opts.duration) : undefined;

      if (opts.estimate) {
        await printEstimate(ctx, {
          model: opts.model,
          type: "video",
          duration,
          resolution: opts.resolution,
          quality: opts.quality,
          audio: opts.audio,
        });
        return;
      }

      const [refs, refVideos, refAudios, startImage, endImage] = await Promise.all([
        resolveRefs(ctx, opts.ref ?? []),
        resolveRefs(ctx, opts.refVideo ?? []),
        resolveRefs(ctx, opts.refAudio ?? []),
        opts.startImage ? resolveRefs(ctx, [opts.startImage]).then((r) => r[0]) : undefined,
        opts.endImage ? resolveRefs(ctx, [opts.endImage]).then((r) => r[0]) : undefined,
      ]);
      const segments = parseSegments(opts.segment ?? []);

      // A video needs at least one driver. The server enforces per-model rules;
      // this just catches an entirely empty invocation early.
      if (!prompt && segments.length === 0 && !startImage && refVideos.length === 0) {
        throw new CliError(
          "Provide a prompt, --segment (multi-prompt), or --start-image.",
          EXIT.USAGE,
        );
      }

      capture("cli_generate", { kind: "video", model: opts.model ?? "default", wait: opts.wait !== false });
      const submitted = await ctx.client.callTool(
        "generate_video",
        compact({
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
          seed: opts.seed ? Number(opts.seed) : undefined,
          project_id: opts.project,
          session_id: opts.session,
          scene_index: opts.scene !== undefined ? Number(opts.scene) : undefined,
          shot_index: opts.shot !== undefined ? Number(opts.shot) : undefined,
        }),
      );
      await handleAsyncJob(ctx, submitted, {
        wait: opts.wait !== false,
        download: opts.download,
        label: "Generating video",
      });
    });

  generate
    .command("voiceover <text...>")
    .description("Generate TTS audio (synchronous — returns an audio URL)")
    .option("--voice <id>", "voice id (see `videodraft models voices`)")
    .option("--language <bcp47>", 'target language, default "en"')
    .option("--project <id>", "attach to a project")
    .option("--scene <n>", "0-based scene index — wires the audio onto that scene")
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
          scene_index: opts.scene !== undefined ? Number(opts.scene) : undefined,
        }),
      );
      const urls = extractOutputUrls(result);
      let downloaded: DownloadedFile[] | undefined;
      if (opts.download && urls.length > 0) {
        downloaded = await downloadOutputs(urls, opts.download, { name: "voiceover" });
      }
      const media = buildMediaDescriptors(urls, "audio");
      emit(ctx.out, { ...result, downloaded_files: downloaded, output_media: media }, (o) => {
        for (const url of urls) process.stdout.write(`${url}\n`);
        for (const f of downloaded ?? []) note(o, fmt.dim(o, `saved ${f.path}`));
      });
    });

  generate
    .command("music <prompt...>")
    .description("Generate background music (Lyria 3)")
    .option("--model <id>", "lyria-3-clip-preview (30s, default) | lyria-3-pro-preview (180s)")
    .option("--ref <url|file>", "reference image to inspire the music (repeatable)", collect, [])
    .option("--project <id>", "link the generation to a project's AI Studio session")
    .option("--attach <project_id>", "also set the track as that project's background music")
    .option("--volume <n>", "0-100 BGM volume when attaching (default 30)")
    .option("--bgm-disabled", "when attaching, store the BGM as disabled (enabled:false)")
    .option("--session <id>", "AI Studio session id")
    .option("--download <path>", "download the audio file")
    .action(async function (this: Command, promptWords: string[]) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const refs = await resolveRefs(ctx, opts.ref ?? []);
      capture("cli_generate", { kind: "music", model: opts.model ?? "default" });
      const result: any = await ctx.client.callTool(
        "generate_music",
        compact({
          prompt: promptWords.join(" "),
          model: opts.model,
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
        downloaded = await downloadOutputs(urls, opts.download, { name: "music" });
      }
      const media = buildMediaDescriptors(urls, "music");
      emit(ctx.out, { ...result, downloaded_files: downloaded, output_media: media }, (o) => {
        for (const url of urls) process.stdout.write(`${url}\n`);
        for (const f of downloaded ?? []) note(o, fmt.dim(o, `saved ${f.path}`));
      });
    });

  const upscale = program.command("upscale").description("Upscale images and videos (Topaz)");

  upscale
    .command("image <url|file>")
    .description("Upscale an image (synchronous)")
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
        compact({ image_url: url, scale: opts.scale, session_id: opts.session }),
      );
      const urls = extractOutputUrls(result);
      let downloaded: DownloadedFile[] | undefined;
      if (opts.download && urls.length > 0) {
        downloaded = await downloadOutputs(urls, opts.download, { name: "upscaled" });
      }
      const media = buildMediaDescriptors(urls, "image");
      emit(ctx.out, { ...result, downloaded_files: downloaded, output_media: media }, (o) => {
        for (const u of urls) process.stdout.write(`${u}\n`);
        for (const f of downloaded ?? []) note(o, fmt.dim(o, `saved ${f.path}`));
      });
    });

  upscale
    .command("video <url|file>")
    .description("Upscale a video (async; waits by default)")
    .option("--scale <factor>", 'e.g. "2x" (default)')
    .option("--session <id>", "AI Studio session id")
    .option("--duration <seconds>", "source duration override (only if auto-probe fails, e.g. >100MB)")
    .option("--width <px>", "source width override (only if auto-probe fails)")
    .option("--height <px>", "source height override (only if auto-probe fails)")
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
