/**
 * `videodraft credits | costs | models | workspaces`
 */

import type { Command } from "commander";
import { buildContext, compact } from "../cli/context.js";
import { emit, kv, table } from "../cli/output.js";

export function registerAccountCommands(program: Command): void {
  program
    .command("credits")
    .description("Show your credit balance")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const balance: any = await ctx.client.callTool("get_credits_balance");
      emit(ctx.out, balance, (o) => {
        kv(o, [
          ["Available credits", balance?.availableCredits],
          ["Monthly allowance", balance?.totalCreditsMonthly],
          ["Used this month", balance?.monthlyCreditsUsed],
          ["Bonus credits", balance?.bonusCredits],
          ["Bonus expiry", balance?.bonusCreditsExpiry],
        ]);
      });
    });

  program
    .command("costs [model]")
    .description("Show credit costs — pass a model id plus video settings for an exact estimate")
    .option("--type <type>", "image | video")
    .option("--duration <seconds>", "video duration in seconds")
    .option("--resolution <res>", 'e.g. "720p", "1080p", "1K", "2K"')
    .option("--quality <tier>", 'e.g. "standard", "pro", "fast"')
    .option("--rendering-speed <tier>", 'image speed/cost tier, e.g. Ideogram V4 "Turbo"/"Balanced"/"Quality"')
    .option("--audio", "include native model audio in the estimate")
    .option("--no-audio", "exclude native model audio")
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
        num?: string;
      }>();
      const result: any = await ctx.client.callTool(
        "get_model_costs",
        compact({
          model_id: model,
          type: opts.type,
          duration_seconds: opts.duration ? Number(opts.duration) : undefined,
          resolution: opts.resolution,
          quality: opts.quality,
          rendering_speed: opts.renderingSpeed,
          generate_audio: opts.audio,
          num_images: opts.num ? Number(opts.num) : undefined,
        }),
      );
      emit(ctx.out, result);
    });

  program
    .command("models [kind]")
    .description("List available models: image | video | voices | styles (default: image + video)")
    .action(async function (this: Command, kind?: string) {
      const ctx = buildContext(this);
      const wanted = kind ?? "all";
      const result: Record<string, unknown> = {};

      if (wanted === "image" || wanted === "all") {
        result.image = await ctx.client.callTool("list_available_image_models");
      }
      if (wanted === "video" || wanted === "all") {
        result.video = await ctx.client.callTool("list_available_video_models");
      }
      if (wanted === "voices") result.voices = await ctx.client.callTool("list_available_voices");
      if (wanted === "styles") result.styles = await ctx.client.callTool("list_available_styles");

      emit(ctx.out, result, (o) => {
        for (const [section, payload] of Object.entries(result)) {
          const models: any[] = Array.isArray(payload)
            ? payload
            : ((payload as any)?.models ?? (payload as any)?.voices ?? (payload as any)?.styles ?? []);
          process.stdout.write(`\n${section.toUpperCase()}\n`);
          if (!Array.isArray(models) || models.length === 0) {
            process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
            continue;
          }
          table(
            o,
            ["id", "name", "cost"],
            models.map((m: any) => [
              String(m.id ?? m.model_id ?? m.voice_id ?? ""),
              String(m.name ?? "").slice(0, 40),
              String(m.credit_cost ?? m.cost ?? m.pricing?.summary ?? ""),
            ]),
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
  const sessions = program.command("sessions").description("AI Studio sessions");

  sessions
    .command("list", { isDefault: true })
    .description("List AI Studio sessions")
    .option("--project <id>", "filter to a project's sessions")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const result: any = await ctx.client.callTool(
        "list_ai_studio_sessions",
        compact({ project_id: this.opts<any>().project }),
      );
      const rows: any[] = result?.sessions ?? result ?? [];
      emit(ctx.out, result, (o) => {
        if (!Array.isArray(rows)) return;
        table(
          o,
          ["id", "name", "created"],
          rows.map((s: any) => [
            String(s.id ?? s.session_id ?? ""),
            String(s.name ?? "").slice(0, 40),
            String(s.created_at ?? s.createdAt ?? "").slice(0, 19),
          ]),
        );
      });
    });

  sessions
    .command("create <name>")
    .description("Create an AI Studio session (reuse its id across standalone generations)")
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
