/** `videodraft kling-voices list|create|delete` provider-scoped voice library. */

import fs from "node:fs";
import type { Command } from "commander";
import { buildContext } from "../cli/context.js";
import { emit, fmt, kv, note } from "../cli/output.js";
import { UsageError } from "../core/errors.js";
import { resolveRefs } from "./generate.js";

export function registerKlingVoiceCommands(program: Command): void {
  const voices = program
    .command("kling-voices")
    .description(
      "Create and manage Kling video-control voice IDs (separate from TTS voices)",
    );

  voices
    .command("list", { isDefault: true })
    .description("List saved Kling voices for the active Fal account")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const result: any = await ctx.client.callTool("list_kling_voices");
      emit(ctx.out, result, (o) => {
        const entries = result?.voices ?? result?.data ?? [];
        const pending = Array.isArray(result?.pendingVoices)
          ? result.pendingVoices
          : [];
        if (!entries.length && !pending.length) {
          note(o, "No Kling voices saved for this Fal account.");
          return;
        }
        entries.forEach((voice: any) => {
          kv(o, [
            ["Name", voice.name],
            ["Voice ID", voice.voiceId],
            ["Record ID", voice.id],
            ["Account", voice.accountScope],
            ["Compatible", voice.compatible],
          ]);
          process.stdout.write("\n");
        });
        if (pending.length) {
          note(
            o,
            `${pending.length} ${pending.length === 1 ? "voice is" : "voices are"} still being finalized. Run this command again in a moment.`,
          );
        }
      });
    });

  voices
    .command("create <url|file>")
    .description(
      "Create a Kling voice from a clean 5-30 second, up-to-50MB single-speaker sample",
    )
    .requiredOption("--name <name>", "name shown in the Kling voice library")
    .option(
      "--confirm-consent",
      "confirm you own the sample or have permission to create and use this voice",
    )
    .option("--estimate", "show the creation cost and exit")
    .action(async function (this: Command, source: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const name = String(opts.name).trim();
      if (!name) {
        throw new UsageError("--name must contain at least one character.");
      }
      if (name.length > 100) {
        throw new UsageError("--name must be 100 characters or fewer.");
      }
      if (opts.estimate) {
        const estimate = await ctx.client.callTool("get_model_costs", {
          model_id: "kling-voice-create",
          type: "audio",
        });
        emit(ctx.out, {
          estimate,
          note: "No voice was created and no credits were spent (--estimate).",
        });
        return;
      }
      if (opts.confirmConsent !== true) {
        throw new UsageError(
          "--confirm-consent is required. Only clone a voice you own or have permission to use.",
        );
      }
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
        if (!fs.existsSync(source)) {
          throw new UsageError(`Voice sample does not exist: ${source}`);
        }
        const extension = source.split(".").pop()?.toLowerCase();
        if (!extension || !["mp3", "wav", "mp4", "mov"].includes(extension)) {
          throw new UsageError(
            "Kling voice samples must be MP3, WAV, MP4, or MOV files.",
          );
        }
        if (fs.statSync(source).size > 50 * 1024 * 1024) {
          throw new UsageError("Kling voice samples can be up to 50 MB.");
        }
      }
      const [voiceUrl] = await resolveRefs(ctx, [source]);
      const result: any = await ctx.client.callTool("create_kling_voice", {
        name,
        voice_url: voiceUrl,
        consent_confirmed: true,
      });
      emit(ctx.out, result, (o) => {
        const voice = result?.voice ?? result;
        note(o, "Kling voice created and saved.");
        kv(o, [
          ["Name", voice?.name],
          ["Voice ID", voice?.voiceId],
          ["Record ID", voice?.id],
          ["Account", voice?.accountScope],
          ["Credits", result?.creditCost],
        ]);
        note(
          o,
          fmt.dim(
            o,
            "Use this opaque string in --element voice_id, or with Kling 2.6 --voice-id. Do not convert numeric-looking IDs to numbers.",
          ),
        );
      });
    });

  voices
    .command("delete <id>")
    .description(
      "Remove a saved Kling voice record (Fal has no provider-side delete API)",
    )
    .action(async function (this: Command, id: string) {
      const ctx = buildContext(this);
      if (!id.trim())
        throw new UsageError("A saved Kling voice record id is required.");
      const result: any = await ctx.client.callTool("delete_kling_voice", {
        id: id.trim(),
      });
      emit(ctx.out, result, (o) =>
        note(
          o,
          "Saved Kling voice removed from VideoDraft. This does not claim provider-side deletion.",
        ),
      );
    });
}
