/**
 * `videodraft credits | costs | models | workspaces`
 */

import type { Command } from "commander";
import { buildContext, compact } from "../cli/context.js";
import { emit, kv, table } from "../cli/output.js";
import { UsageError } from "../core/errors.js";
import { resetAllConnectionSessions } from "../core/session.js";

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
      "--voice-control",
      "Kling element voice_id pricing (V3 Standard/Pro only; O3/4K are unavailable)",
    )
    .option(
      "--allow-real-people",
      "Seedance 2.x: estimate the higher tier-specific Fal rate used by the real-person opt-in",
    )
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
        voiceControl?: boolean;
        allowRealPeople?: boolean;
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
          voice_control: opts.voiceControl,
          allow_real_people: opts.allowRealPeople ? true : undefined,
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
              // A card may belong to more than one category — gemini-omni-flash
              // is both the generation default and the preferred video_edit
              // model — and declares that in `categories`. Match either field so
              // dual-category cards surface under both.
              models: (video?.models ?? []).filter((model: any) =>
                Array.isArray(model.categories)
                  ? model.categories.includes(opts.category)
                  : model.category === opts.category,
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
    .command("current")
    .description(
      "Show the connection session this directory's standalone generations are filed under",
    )
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const info = ctx.session?.describe();
      const record = info?.record ?? null;
      const active = Boolean(record) && !info?.expired;
      const sessionId = active ? (info?.sessionId ?? null) : null;
      // The token reserves an id; the ai_studio_sessions row only exists
      // once the first generation lands. Verify before advertising a URL,
      // or `sessions current` hands out a link the web app cannot open.
      let created = false;
      if (sessionId) {
        try {
          const listed: any = await ctx.client.callTool(
            "list_ai_studio_sessions",
            { limit: 200 },
          );
          const rows: any[] = listed?.sessions ?? [];
          created = rows.some(
            (row) => (row?.id ?? row?.session_id) === sessionId,
          );
        } catch {
          created = false; // offline/unknown → do not advertise the URL
        }
      }
      const result = {
        enabled: Boolean(ctx.session),
        scope: info?.scope ?? null,
        active,
        expired: Boolean(info?.expired),
        session_id: sessionId,
        /** False until the first generation creates the AI Studio row. */
        session_created: created,
        url:
          sessionId && created
            ? `${ctx.baseUrl}/ai-studio?session=${sessionId}`
            : null,
        created_at: active ? (record?.createdAt ?? null) : null,
        last_used_at: active ? (record?.lastUsedAt ?? null) : null,
        file: info?.file ?? null,
        note: ctx.session
          ? active
            ? created
              ? "Project-less generations from this directory share this AI Studio session. `videodraft sessions reset` starts a new one; --session <id> pins a specific session."
              : "Session id reserved for this directory; the AI Studio session appears on the first generation. `videodraft sessions reset` starts a new one; --session <id> pins a specific session."
            : info?.expired
              ? "The previous session idled out (12h); the next command starts a new one. --session <id> pins a specific session instead."
              : "No session yet; the next command creates one. --session <id> pins a specific session instead."
          : 'Disabled via VIDEODRAFT_NO_SESSION; generations fall back to the shared "Agent (MCP)" session unless --session is passed.',
      };
      emit(ctx.out, result, () => {
        const state = !result.enabled
          ? "disabled"
          : result.active
            ? `${result.session_created ? "active" : "reserved"}  session=${result.session_id ?? "?"}`
            : result.expired
              ? "expired"
              : "none yet";
        process.stdout.write(
          `${state}  scope=${result.scope ?? "-"}\n${result.url ? `${result.url}\n` : ""}${result.note}\n`,
        );
      });
    });

  sessions
    .command("reset")
    .description(
      "Forget this directory's connection session so the next generation starts a fresh AI Studio session (--all: every directory)",
    )
    .option("--all", "reset every stored connection session")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      let removed = 0;
      if (opts.all) {
        removed = resetAllConnectionSessions();
      } else if (ctx.session) {
        const had = Boolean(ctx.session.describe().record);
        ctx.session.reset();
        removed = had ? 1 : 0;
      }
      const result = {
        reset: removed,
        scope: opts.all ? "all" : (ctx.session?.describe().scope ?? null),
      };
      emit(ctx.out, result, () => {
        process.stdout.write(
          removed > 0
            ? `Reset ${removed} connection session${removed === 1 ? "" : "s"}; the next generation starts a new AI Studio session.\n`
            : "Nothing to reset.\n",
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
        const id = result?.session?.id ?? result?.session_id ?? result?.id;
        process.stdout.write(`${id ?? JSON.stringify(result)}\n`);
      });
    });
}
