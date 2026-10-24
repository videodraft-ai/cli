import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  buildContext,
  compact,
  sessionArg,
  sessionProfileKey,
} from "../cli/context.js";
import { emit, note } from "../cli/output.js";
import { capture } from "../cli/telemetry.js";
import { resolveRefs, handleAsyncJob } from "./generate.js";
import { CliError, UsageError } from "../core/errors.js";
import { prepareBackgroundRemovalSource } from "../core/background-removal-source.js";

export function validateBackgroundRemovalDownload(
  destination: string | undefined,
  kind: "image" | "video",
) {
  if (
    !destination ||
    destination.endsWith("/") ||
    destination.includes("{ext}") ||
    (fs.existsSync(destination) && fs.statSync(destination).isDirectory())
  )
    return;
  const extension = path.extname(destination).toLowerCase();
  const expected = kind === "image" ? ".png" : ".webm";
  if (extension && extension !== expected)
    throw new UsageError(
      `Background removal returns ${expected}. Use a ${expected} filename or a directory for --download.`,
    );
}

export function registerBackgroundRemovalCommands(program: Command) {
  const group = program
    .command("remove-background")
    .description("Remove image or video backgrounds; preserve transparency");
  for (const kind of ["image", "video"] as const) {
    const command = group
      .command(`${kind} <url|file>`)
      .description(
        kind === "image"
          ? "Pixelcut image cutout to transparent PNG"
          : "VEED Fast video cutout to transparent WebM",
      )
      .option(
        "--session <id>",
        "AI Studio session",
        process.env.VIDEODRAFT_SESSION,
      )
      .option(
        "--idempotency-key <uuid>",
        "reuse this UUID to recover the same submission safely",
      )
      .option("--estimate", "quote verified source cost without generating")
      .option(
        "--max-credits <n>",
        "maximum authorized VideoDraft credits; 0 requires BYOK",
      )
      .option("--no-wait", "return the job ID immediately")
      .option(
        "--download <path>",
        `download the ${kind === "image" ? "PNG" : "WebM"} result`,
      );
    if (kind === "video")
      command
        .option(
          "--subject <person|object>",
          "subject to keep; use object for products or animals",
          "person",
        )
        .option(
          "--no-refine-edges",
          "disable foreground edge refinement for a lower price",
        );
    command.action(async function (this: Command, source: string) {
      const opts = this.opts<any>();
      if (kind === "video" && !["person", "object"].includes(opts.subject))
        throw new UsageError("--subject must be person or object.");
      const operationId = opts.idempotencyKey || randomUUID();
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          operationId,
        )
      )
        throw new UsageError("--idempotency-key must be a UUID.");
      validateBackgroundRemovalDownload(opts.download, kind);
      const maxCredits =
        opts.maxCredits === undefined ? undefined : Number(opts.maxCredits);
      if (
        maxCredits !== undefined &&
        (!Number.isSafeInteger(maxCredits) || maxCredits < 0)
      )
        throw new UsageError("--max-credits must be a nonnegative integer.");
      const ctx = buildContext(this);
      const upload = async () => (await resolveRefs(ctx, [source]))[0]!;
      const url = opts.estimate
        ? await upload()
        : await prepareBackgroundRemovalSource(
            JSON.stringify([
              ctx.baseUrl,
              sessionProfileKey(
                ctx.profileName,
                ctx.flags.token ?? process.env.VIDEODRAFT_API_KEY,
              ),
              process.cwd(),
            ]),
            operationId,
            source,
            upload,
          );
      if (opts.estimate) {
        const result: any = await ctx.client.callTool(
          "get_model_costs",
          compact({
            model_id:
              kind === "image"
                ? "pixelcut-background-removal"
                : "veed-background-removal",
            source_url: url,
            refine_edges:
              kind === "video" ? opts.refineEdges !== false : undefined,
          }),
        );
        emit(ctx.out, result, (o) => note(o, `Cost: ${result.cost} credits`));
        return;
      }
      capture("cli_background_removal", {
        kind,
        refine_edges: opts.refineEdges !== false,
      });
      const imageKind = kind === "image";
      const removalTool = imageKind
        ? "remove_image_background"
        : "remove_video_background";
      note(ctx.out, `Background removal job: ${operationId}`);
      let submitted: any;
      try {
        submitted = await ctx.client.callTool(
          removalTool,
          compact({
            ...(kind === "image"
              ? { image_url: url }
              : {
                  video_url: url,
                  subject: opts.subject,
                  refine_edges: opts.refineEdges !== false,
                }),
            session_id: sessionArg(this, opts),
            idempotency_key: operationId,
            max_credits: maxCredits,
          }),
        );
      } catch (error) {
        const failure =
          error instanceof CliError
            ? error
            : new CliError(
                error instanceof Error ? error.message : "Submission failed.",
              );
        failure.hint = `Check job ${operationId} with status, or retry using --idempotency-key ${operationId}. Keep the same source and settings.`;
        failure.data = {
          ...(failure.data && typeof failure.data === "object"
            ? failure.data
            : {}),
          job_id: operationId,
        };
        throw failure;
      }
      await handleAsyncJob(ctx, submitted, {
        wait: opts.wait !== false,
        download: opts.download,
        label: "Removing background",
      });
    });
  }
}
