/**
 * `videodraft avatar ...` — talking-head videos (script → create → render → poll).
 */

import fs from "node:fs";
import type { Command } from "commander";
import { buildContext, compact } from "../cli/context.js";
import { emit, fmt, note, spinner, table } from "../cli/output.js";
import { uploadFile } from "../core/upload.js";
import { TimeoutError } from "../core/errors.js";
import { capture } from "../cli/telemetry.js";

export function registerAvatarCommands(program: Command): void {
  const avatar = program.command("avatar").description("Avatar / talking-head videos");

  avatar
    .command("script <idea...>")
    .description("Generate a ~30s spoken script for an avatar video (free)")
    .option("--style <style>", "narrative | ad-style | casual-talk | promotional | educational")
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
    .description("Create an avatar video from an image + script (does not render yet)")
    .requiredOption("--script <text>", "the spoken script (~30s)")
    .option("--voice <id>", "TTS voice id")
    .option("--name <name>", "avatar display name")
    .option("--ar <ratio>", 'aspect ratio (default "9:16")')
    .option("--language <bcp47>", "target language")
    .action(async function (this: Command, source: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      let imageUrl = source;
      if (!/^https?:\/\//.test(source) && fs.existsSync(source)) {
        const uploaded = await uploadFile(ctx.client, source);
        imageUrl = uploaded.url;
      }
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
      emit(ctx.out, result, (o) => {
        note(o, fmt.green(o, `Avatar video ${result?.avatar_video_id ?? "created"}.`));
        note(o, fmt.dim(o, `Render (paid): videodraft avatar render ${result?.avatar_video_id}`));
      });
    });

  avatar
    .command("render <avatar_video_id>")
    .description("Render an avatar video (spends credits; waits by default)")
    .option("--resolution <res>", '"480p" | "720p" (default 720p)')
    .option("--no-wait", "queue the render and return immediately")
    .action(async function (this: Command, avatarVideoId: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      capture("cli_avatar", { step: "render" });
      const started = await ctx.client.callTool(
        "render_avatar_video",
        compact({ avatar_video_id: avatarVideoId, resolution: opts.resolution }),
      );
      if (opts.wait === false) {
        emit(ctx.out, started, (o) =>
          note(o, `Render queued. Check with: videodraft avatar get ${avatarVideoId}`),
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
          const exportStatus = String(status?.export_status ?? "unknown");
          spin.update(`Rendering avatar video — ${exportStatus}`);
          if (exportStatus === "completed") {
            spin.stop();
            emit(ctx.out, status, (o) => {
              note(o, fmt.green(o, "Avatar render completed."));
              if (status?.video_url) process.stdout.write(`${status.video_url}\n`);
            });
            return;
          }
          if (exportStatus === "failed") {
            spin.stop();
            emit(ctx.out, status, (o) => note(o, fmt.red(o, "Avatar render failed.")));
            process.exitCode = 1;
            return;
          }
          if (Date.now() > deadline) {
            throw new TimeoutError(
              `Timed out waiting for avatar render ${avatarVideoId} (last: ${exportStatus}).`,
            );
          }
          await new Promise((r) => setTimeout(r, Math.max(ctx.intervalMs, 5_000)));
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
      const result = await ctx.client.callTool("get_avatar_video", { avatar_video_id: avatarVideoId });
      emit(ctx.out, result);
    });

  avatar
    .command("list")
    .description("List your avatar videos")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const result: any = await ctx.client.callTool("list_avatar_videos");
      const rows: any[] = result?.avatar_videos ?? result?.videos ?? result ?? [];
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
