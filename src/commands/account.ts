/**
 * `videodraft credits | costs | models | workspaces`
 */

import type { Command } from "commander";
import { buildContext, compact } from "../cli/context.js";
import { emit, kv, table } from "../cli/output.js";
import { UsageError } from "../core/errors.js";

export function registerAccountCommands(program: Command): void {
  program
    .command("credits")
    .description("Show your credit balance")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const balance: any = await ctx.client.callTool("get_credits_balance");
      emit(ctx.out, balance, (o) => {
        kv(o, [
          ["Plan", balance?.planId],
          ["Available credits", balance?.availableCredits],
          ["Monthly allowance", balance?.totalCreditsMonthly],
          ["Used this month", balance?.monthlyCreditsUsed],
          ["Bonus credits", balance?.bonusCredits],
          ["Bonus expiry", balance?.bonusCreditsExpiry],
          ["Last monthly reset", balance?.lastMonthlyReset],
          ["Next monthly reset", balance?.nextMonthlyReset],
        ]);
      });
    });

  program
    .command("costs [model]")
    .description(
      "Show credit costs. Pass a model id, or an image display name, plus settings for an exact estimate",
    )
    .option("--type <type>", "image | video | audio")
    .option("--duration <seconds>", "video/audio duration in seconds")
    .option("--length <seconds>", "ElevenLabs Music output length in seconds")
    .option(
      "--chars <n>",
      'character count (ElevenLabs Dialogue, or voiceover TTS via model id "voiceover")',
    )
    .option("--resolution <res>", 'e.g. "720p", "1080p", "1K", "2K"')
    .option("--quality <tier>", 'e.g. "standard", "pro", "fast"')
    .option(
      "--rendering-speed <tier>",
      'image speed/cost tier, e.g. Ideogram V4 "Turbo"/"Balanced"/"Quality"',
    )
    .option("--audio", "include native model audio in the estimate")
    .option("--no-audio", "exclude native model audio")
    .option(
      "--ref-images <n>",
      "input/reference image count for MiniMax H3 or Grok 1.5",
    )
    .option(
      "--ref-video-seconds <seconds>",
      "MiniMax H3 combined reference-video duration",
    )
    .option("--num <n>", "image batch size")
    .action(async function (this: Command, model?: string) {
      const ctx = buildContext(this);
      const opts = this.opts<{
        type?: string;
        duration?: string;
        resolution?: string;
        quality?: string;
        renderingSpeed?: string;
        audio?: boolean;
        length?: string;
        chars?: string;
        num?: string;
        refImages?: string;
        refVideoSeconds?: string;
      }>();
      const result: any = await ctx.client.callTool(
        "get_model_costs",
        compact({
          model_id: model,
          type: opts.type,
          duration_seconds: opts.duration ? Number(opts.duration) : undefined,
          length_seconds: opts.length ? Number(opts.length) : undefined,
          characters: opts.chars ? Number(opts.chars) : undefined,
          resolution: opts.resolution,
          quality: opts.quality,
          rendering_speed: opts.renderingSpeed,
          generate_audio: opts.audio,
          reference_image_count: opts.refImages
            ? Number(opts.refImages)
            : undefined,
          reference_video_duration_seconds: opts.refVideoSeconds
            ? Number(opts.refVideoSeconds)
            : undefined,
          num_images: opts.num ? Number(opts.num) : undefined,
        }),
      );
      emit(ctx.out, result);
    });

  program
    .command("models [kind]")
    .description(
      "List available models: image | video | audio | voices | styles (default: image + video + audio)",
    )
    .option(
      "--category <name>",
      "video only: generation | video_edit | motion_control | avatar_lipsync | upscale",
    )
    .action(async function (this: Command, kind?: string) {
      const ctx = buildContext(this);
      const opts = this.opts<{ category?: string }>();
      const wanted = kind ?? "all";
      const videoCategories = new Set([
        "generation",
        "video_edit",
        "motion_control",
        "avatar_lipsync",
        "upscale",
      ]);
      if (opts.category && !videoCategories.has(opts.category)) {
        throw new UsageError(
          `Unknown video category "${opts.category}". Use generation, video_edit, motion_control, avatar_lipsync, or upscale.`,
        );
      }
      if (opts.category && wanted !== "video" && wanted !== "all") {
        throw new UsageError(
          "--category is only valid for the video model catalog.",
        );
      }
      const result: Record<string, unknown> = {};

      if (wanted === "image" || wanted === "all") {
        result.image = await ctx.client.callTool("list_available_image_models");
      }
      if (wanted === "video" || wanted === "all") {
        const video: any = await ctx.client.callTool(
          "list_available_video_models",
        );
        result.video = opts.category
          ? {
              ...video,
              models: (video?.models ?? []).filter(
                (model: any) => model.category === opts.category,
              ),
              selected_category: opts.category,
            }
          : video;
      }
      if (wanted === "audio" || wanted === "all") {
        result.audio = await ctx.client.callTool("list_available_audio_models");
      }
      if (wanted === "voices") {
        result.voices = await ctx.client.callTool("list_available_voices");
      }
      if (wanted === "styles") {
        result.styles = await ctx.client.callTool("list_available_styles");
      }

      emit(ctx.out, result, (o) => {
        for (const [section, payload] of Object.entries(result)) {
          const models: any[] = Array.isArray(payload)
            ? payload
            : ((payload as any)?.models ??
              (payload as any)?.voices ??
              (payload as any)?.styles ??
              []);
          process.stdout.write(`\n${section.toUpperCase()}\n`);
          if (!Array.isArray(models) || models.length === 0) {
            process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
            continue;
          }
          const rows: string[][] = models.map((m: any) => [
            String(m.id ?? m.model_id ?? m.voice_id ?? ""),
            String(m.name ?? "").slice(0, 40),
            String(m.category ?? ""),
            String(m.tool ?? ""),
            String(m.credit_cost ?? m.cost ?? m.pricing?.summary ?? ""),
          ]);
          table(
            o,
            section === "video"
              ? ["id", "name", "category", "tool", "cost"]
              : ["id", "name", "cost"],
            section === "video"
              ? rows
              : rows.map((row) => [row[0] ?? "", row[1] ?? "", row[4] ?? ""]),
          );
        }
      });
    });

  program
    .command("workspaces")
    .description("List your workspaces (the active one is bound to your token)")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const result: any = await ctx.client.callTool("list_workspaces");
      const workspaces: any[] = result?.workspaces ?? result ?? [];
      emit(ctx.out, result, (o) => {
        table(
          o,
          ["id", "name", "role", "active"],
          workspaces.map((w: any) => [
            String(w.id ?? ""),
            String(w.name ?? ""),
            String(w.role ?? ""),
            w.is_active || w.active ? "✓" : "",
          ]),
        );
      });
    });

  // AI Studio sessions — group standalone (project-less) generations.
  const sessions = program
    .command("sessions")
    .description("AI Studio sessions");

  sessions
    .command("list", { isDefault: true })
    .description("List AI Studio sessions (owned + shared)")
    .option("--project <id>", "filter to a project's sessions")
    .option("--name <fragment>", "filter by name (case-insensitive)")
    .option("--limit <n>", "max rows (default 50)")
    .option("--offset <n>", "pagination offset (default 0)")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const result: any = await ctx.client.callTool(
        "list_ai_studio_sessions",
        compact({
          project_id: opts.project,
          name: opts.name,
          limit: opts.limit ? Number(opts.limit) : undefined,
          offset: opts.offset ? Number(opts.offset) : undefined,
        }),
      );
      const rows: any[] = result?.sessions ?? result ?? [];
      emit(ctx.out, result, (o) => {
        if (!Array.isArray(rows)) return;
        table(
          o,
          ["id", "name", "role", "items", "created"],
          rows.map((s: any) => [
            String(s.id ?? s.session_id ?? ""),
            String(s.name ?? "").slice(0, 40),
            String(s.role ?? (s.is_owner === false ? "member" : "owner")),
            `${s.image_count ?? 0}i/${s.video_count ?? 0}v/${s.sound_count ?? 0}s`,
            String(s.created_at ?? s.createdAt ?? "").slice(0, 19),
          ]),
        );
      });
    });

  sessions
    .command("create <name>")
    .description(
      "Create an AI Studio session (reuse its id across standalone generations)",
    )
    .option("--project <id>", "attach the session to a project")
    .action(async function (this: Command, name: string) {
      const ctx = buildContext(this);
      const result: any = await ctx.client.callTool(
        "create_ai_studio_session",
        compact({ name, project_id: this.opts<any>().project }),
      );
      emit(ctx.out, result, (o) => {
        const id = result?.session_id ?? result?.id;
        process.stdout.write(`${id ?? JSON.stringify(result)}\n`);
      });
    });
}
