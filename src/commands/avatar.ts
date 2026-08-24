/**
 * `videodraft avatar ...` — talking-head videos (script → create → render → poll).
 */

import type { Command } from "commander";
import { buildContext, compact, sessionArg } from "../cli/context.js";
import { emit, fmt, note, spinner, table } from "../cli/output.js";
import { buildMediaDescriptors } from "../core/media.js";
import { extractOutputUrls } from "../core/poll.js";
import { TimeoutError, UsageError } from "../core/errors.js";
import { capture } from "../cli/telemetry.js";
import { handleAsyncJob, resolveRefs } from "./generate.js";

function positiveNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${label} must be a positive number.`);
  }
  return parsed;
}

export function registerAvatarCommands(program: Command): void {
  const avatar = program
    .command("avatar")
    .description("Avatar / talking-head videos with VEED Fabric");

  avatar
    .command("script <idea...>")
    .description("Generate a ~30s spoken script for an avatar video (free)")
    .option(
      "--style <style>",
      "narrative | ad-style | casual-talk | promotional | educational",
    )
    .action(async function (this: Command, ideaWords: string[]) {
      const ctx = buildContext(this);
      const result = await ctx.client.callTool(
        "generate_avatar_script",
        compact({ idea: ideaWords.join(" "), style: this.opts<any>().style }),
      );
      emit(ctx.out, result);
    });

  avatar
    .command("create <image_url_or_file>")
    .description(
      "Create VEED Fabric avatar speech from a portrait + script (free; render separately)",
    )
    .requiredOption("--script <text>", "the spoken script (~30s)")
    .option("--voice <id>", "TTS voice id (default ElevenLabs Brittney)")
    .option("--name <name>", "avatar display name")
    .option("--ar <ratio>", 'aspect ratio (default "9:16")')
    .option("--language <bcp47>", "target language")
    .action(async function (this: Command, source: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const [imageUrl] = await resolveRefs(ctx, [source]);
      capture("cli_avatar", { step: "create" });
      const result: any = await ctx.client.callTool(
        "create_avatar_video",
        compact({
          script: opts.script,
          character_image_url: imageUrl,
          voice_id: opts.voice,
          character_name: opts.name,
          aspect_ratio: opts.ar,
          target_language: opts.language,
        }),
      );
      const media = buildMediaDescriptors(extractOutputUrls(result), "audio");
      emit(ctx.out, { ...result, output_media: media }, (o) => {
        note(
          o,
          fmt.green(o, `Avatar video ${result?.avatar_video_id ?? "created"}.`),
        );
        note(
          o,
          fmt.dim(
            o,
            `Render (paid): videodraft avatar render ${result?.avatar_video_id}`,
          ),
        );
      });
    });

  avatar
    .command("fabric <image_url_or_file>")
    .description(
      "Generate a direct VEED Fabric video from a portrait plus text or audio",
    )
    .option("--text <text>", "text for Fabric to speak")
    .option("--audio <url|file>", "existing audio to lip-sync")
    .option(
      "--voice-description <text>",
      "text-mode voice direction, for example a warm British narrator",
    )
    .option("--speed <mode>", 'audio mode: "normal" or "fast" (default normal)')
    .option("--resolution <res>", '"480p" or "720p" (default 720p)')
    .option(
      "--audio-duration <seconds>",
      "optional estimate hint; server verifies MCP billing duration",
    )
    .option("--project <id>", "group in a project's AI Studio session")
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: this directory's connection session; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--download <path>", "download the finished video")
    .option("--no-wait", "submit and return the job id immediately")
    .option("--estimate", "print the cost estimate and exit")
    .action(async function (this: Command, imageSource: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const hasText = typeof opts.text === "string" && opts.text.trim();
      const hasAudio = typeof opts.audio === "string" && opts.audio.trim();
      if (Boolean(hasText) === Boolean(hasAudio)) {
        throw new UsageError("Provide exactly one of --text or --audio.");
      }
      const mode = hasAudio ? "audio" : "text";
      const speed = opts.speed ?? "normal";
      if (!["normal", "fast"].includes(speed)) {
        throw new UsageError('--speed must be "normal" or "fast".');
      }
      if (mode === "text" && speed !== "normal") {
        throw new UsageError("--speed applies only with --audio.");
      }
      const resolution = opts.resolution ?? "720p";
      if (!["480p", "720p"].includes(resolution)) {
        throw new UsageError('--resolution must be "480p" or "720p".');
      }
      if (mode === "audio" && opts.voiceDescription) {
        throw new UsageError("--voice-description applies only with --text.");
      }
      const audioDuration = positiveNumber(
        opts.audioDuration,
        "--audio-duration",
      );
      const model =
        mode === "text"
          ? "veed-fabric-text"
          : speed === "fast"
            ? "veed-fabric-fast"
            : "veed-fabric";
      const estimatedDuration =
        mode === "text"
          ? Math.max(
              1,
              Math.min(120, Math.ceil(String(opts.text).trim().length / 15)),
            )
          : audioDuration;
      if (opts.estimate) {
        const estimate = await ctx.client.callTool(
          "get_model_costs",
          compact({
            model_id: model,
            type: "video",
            duration_seconds: estimatedDuration,
            resolution,
          }),
        );
        emit(ctx.out, {
          estimate,
          note: "No credits were spent (--estimate).",
        });
        return;
      }

      const [imageUrl] = await resolveRefs(ctx, [imageSource]);
      const audioUrl = hasAudio
        ? (await resolveRefs(ctx, [opts.audio]))[0]
        : undefined;
      capture("cli_avatar", { step: "fabric", mode, speed });
      const submitted = await ctx.client.callTool(
        "generate_veed_fabric_video",
        compact({
          image_url: imageUrl,
          mode,
          text: mode === "text" ? opts.text : undefined,
          voice_description: opts.voiceDescription,
          audio_url: audioUrl,
          audio_duration_seconds: audioDuration,
          speed,
          resolution,
          project_id: opts.project,
          session_id: sessionArg(this, opts),
        }),
      );
      await handleAsyncJob(ctx, submitted, {
        wait: opts.wait !== false,
        download: opts.download,
        label: "Generating VEED Fabric video",
      });
    });

  avatar
    .command("lipsync <video_url_or_file>")
    .description("Lip-sync an existing video to audio with Sync Labs")
    .requiredOption("--audio <url|file>", "replacement speech/audio track")
    .option(
      "--sync-mode <mode>",
      "loop | bounce | cut_off | silence | remap (default loop)",
    )
    .option("--temperature <0-1>", "expression intensity (default 0.5)")
    .option(
      "--active-speaker",
      "detect the active speaker in multi-person video",
    )
    .option(
      "--audio-duration <seconds>",
      "optional estimate hint; server verifies MCP billing duration",
    )
    .option("--project <id>", "group in a project's AI Studio session")
    .option(
      "--session <id>",
      "pin an AI Studio session id (default: this directory's connection session; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--download <path>", "download the finished video")
    .option("--no-wait", "submit and return the job id immediately")
    .option("--estimate", "print the cost estimate and exit")
    .action(async function (this: Command, videoSource: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const audioDuration = positiveNumber(
        opts.audioDuration,
        "--audio-duration",
      );
      if (
        opts.syncMode &&
        !["loop", "bounce", "cut_off", "silence", "remap"].includes(
          opts.syncMode,
        )
      ) {
        throw new UsageError(
          "--sync-mode must be loop, bounce, cut_off, silence, or remap.",
        );
      }
      if (opts.temperature !== undefined) {
        const temperature = Number(opts.temperature);
        if (
          !Number.isFinite(temperature) ||
          temperature < 0 ||
          temperature > 1
        ) {
          throw new UsageError("--temperature must be between 0 and 1.");
        }
      }
      if (opts.estimate) {
        const estimate = await ctx.client.callTool(
          "get_model_costs",
          compact({
            model_id: "sync-lipsync-2",
            type: "video",
            duration_seconds: audioDuration,
          }),
        );
        emit(ctx.out, {
          estimate,
          note: "No credits were spent (--estimate).",
        });
        return;
      }

      const [[videoUrl], [audioUrl]] = await Promise.all([
        resolveRefs(ctx, [videoSource]),
        resolveRefs(ctx, [opts.audio]),
      ]);
      capture("cli_avatar", { step: "sync_lipsync" });
      const submitted = await ctx.client.callTool(
        "generate_sync_lipsync_video",
        compact({
          video_url: videoUrl,
          audio_url: audioUrl,
          audio_duration_seconds: audioDuration,
          sync_mode: opts.syncMode,
          temperature:
            opts.temperature !== undefined
              ? Number(opts.temperature)
              : undefined,
          active_speaker: opts.activeSpeaker ? true : undefined,
          project_id: opts.project,
          session_id: sessionArg(this, opts),
        }),
      );
      await handleAsyncJob(ctx, submitted, {
        wait: opts.wait !== false,
        download: opts.download,
        label: "Lip-syncing video",
      });
    });

  avatar
    .command("render <avatar_video_id>")
    .description(
      "Render an avatar video with VEED Fabric (spends credits; waits by default)",
    )
    .option("--resolution <res>", '"480p" | "720p" (default 720p)')
    .option("--no-wait", "queue the render and return immediately")
    .action(async function (this: Command, avatarVideoId: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      capture("cli_avatar", { step: "render" });
      const started = await ctx.client.callTool(
        "render_avatar_video",
        compact({
          avatar_video_id: avatarVideoId,
          resolution: opts.resolution,
        }),
      );
      if (opts.wait === false) {
        emit(ctx.out, started, (o) =>
          note(
            o,
            `Render queued. Check with: videodraft avatar get ${avatarVideoId}`,
          ),
        );
        return;
      }
      const spin = spinner(ctx.out, "Rendering avatar video…");
      const deadline = Date.now() + ctx.timeoutMs;
      try {
        for (;;) {
          const status: any = await ctx.client.callTool("get_avatar_video", {
            avatar_video_id: avatarVideoId,
          });
          const exportStatus = String(
            status?.status ??
              status?.export_status ??
              status?.data?.export_status ??
              "unknown",
          );
          spin.update(`Rendering avatar video — ${exportStatus}`);
          if (exportStatus === "completed") {
            spin.stop();
            const media = buildMediaDescriptors(
              extractOutputUrls(status),
              "video",
            );
            emit(ctx.out, { ...status, output_media: media }, (o) => {
              note(o, fmt.green(o, "Avatar render completed."));
              if (status?.video_url)
                process.stdout.write(`${status.video_url}\n`);
            });
            return;
          }
          if (exportStatus === "failed") {
            spin.stop();
            emit(ctx.out, status, (o) =>
              note(o, fmt.red(o, "Avatar render failed.")),
            );
            process.exitCode = 1;
            return;
          }
          if (Date.now() > deadline) {
            throw new TimeoutError(
              `Timed out waiting for avatar render ${avatarVideoId} (last: ${exportStatus}).`,
            );
          }
          await new Promise((r) =>
            setTimeout(r, Math.max(ctx.intervalMs, 5_000)),
          );
        }
      } catch (err) {
        spin.stop();
        throw err;
      }
    });

  avatar
    .command("get <avatar_video_id>")
    .description("Fetch one avatar video (status + video_url when rendered)")
    .action(async function (this: Command, avatarVideoId: string) {
      const ctx = buildContext(this);
      const result: any = await ctx.client.callTool("get_avatar_video", {
        avatar_video_id: avatarVideoId,
      });
      const media = buildMediaDescriptors(extractOutputUrls(result), "video");
      emit(ctx.out, { ...result, output_media: media });
    });

  avatar
    .command("list")
    .description("List your avatar videos")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const result: any = await ctx.client.callTool("list_avatar_videos");
      const rows: any[] =
        result?.avatar_videos ?? result?.videos ?? result ?? [];
      emit(ctx.out, result, (o) => {
        if (!Array.isArray(rows)) return;
        table(
          o,
          ["id", "name", "status"],
          rows.map((v: any) => [
            String(v.id ?? v.avatar_video_id ?? ""),
            String(v.character_name ?? v.name ?? "").slice(0, 30),
            String(v.export_status ?? v.status ?? ""),
          ]),
        );
      });
    });
}
