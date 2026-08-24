/**
 * `videodraft status | wait | generations` — async-job plumbing.
 */

import type { Command } from "commander";
import { buildContext, compact, sessionArg } from "../cli/context.js";
import { emit, fmt, note, spinner, table } from "../cli/output.js";
import { pollGenerationsBatch, extractOutputUrls } from "../core/poll.js";
import { buildMediaDescriptors } from "../core/media.js";
import {
  downloadOutputs,
  savedLine,
  type DownloadedFile,
} from "../core/download.js";
import { CliError, EXIT, seedanceRealPersonRetryHint } from "../core/errors.js";

export function registerJobCommands(program: Command): void {
  program
    .command("status <job_id>")
    .description("Check an async generation job once (no waiting)")
    .option("--project <id>", "project id for fallback lookups")
    .option("--scene-id <id>", "scene id for fallback lookups")
    .action(async function (this: Command, jobId: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const result: any = await ctx.client.callTool(
        "check_generation_status",
        compact({
          job_id: jobId,
          project_id: opts.project,
          scene_id: opts.sceneId,
        }),
      );
      const media = buildMediaDescriptors(
        extractOutputUrls(result),
        result?.type,
      );
      emit(ctx.out, { ...result, output_media: media }, (o) => {
        note(o, `${jobId}: ${result?.status ?? "unknown"}`);
        if (result?.status === "failed" && result?.error) {
          note(o, fmt.red(o, String(result.error)));
          const retryHint = seedanceRealPersonRetryHint(result);
          if (retryHint) note(o, fmt.dim(o, retryHint));
        }
        for (const url of extractOutputUrls(result))
          process.stdout.write(`${url}\n`);
      });
    });

  program
    .command("wait <job_ids...>")
    .description(
      "Block until generation job(s) finish. Multiple ids poll in ONE process with ONE batched request per tick — prefer this over parallel `wait` processes",
    )
    .option(
      "--download <path>",
      "download outputs (template: {job_id} {index} {ext})",
    )
    .action(async function (this: Command, jobIds: string[]) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      // A concrete filename template would make every job overwrite the same
      // file — require a {job_id} (or per-job {name}) placeholder, or a directory.
      if (
        jobIds.length > 1 &&
        typeof opts.download === "string" &&
        !opts.download.includes("{job_id}") &&
        /\.[A-Za-z0-9]+$/.test(opts.download)
      ) {
        throw new CliError(
          `--download "${opts.download}" would be overwritten by each job. Include {job_id} in the template (e.g. "out/{job_id}_{index}.{ext}") or pass a directory.`,
          EXIT.USAGE,
        );
      }
      const label =
        jobIds.length === 1 ? `job ${jobIds[0]}` : `${jobIds.length} jobs`;
      const spin = spinner(ctx.out, `Waiting for ${label}…`);
      try {
        const results = await pollGenerationsBatch(ctx.client, jobIds, {
          intervalMs: ctx.intervalMs,
          timeoutMs: ctx.timeoutMs,
          adaptive: ctx.adaptive,
          onTick: (progress) =>
            spin.update(`Waiting for ${label} — ${progress}`),
        });
        spin.stop();

        const rows: any[] = [];
        let failures = 0;
        for (const jobId of jobIds) {
          const result = results.get(jobId)!;
          let downloaded: DownloadedFile[] | undefined;
          if (result.status === "failed") {
            failures++;
          } else if (opts.download && result.outputUrls.length > 0) {
            downloaded = await downloadOutputs(
              result.outputUrls,
              opts.download,
              { job_id: jobId },
            );
          }
          rows.push({
            job_id: jobId,
            status: result.status,
            outputs: result.outputUrls,
            downloaded_files: downloaded,
            output_media: buildMediaDescriptors(
              result.outputUrls,
              result.payload?.type,
            ),
            ...(result.status === "failed"
              ? {
                  error: result.payload?.error,
                  ...(result.payload?.code
                    ? { code: result.payload.code }
                    : {}),
                  ...(result.payload?.retryable !== undefined
                    ? { retryable: result.payload.retryable }
                    : {}),
                  ...(result.payload?.retry_with
                    ? { retry_with: result.payload.retry_with }
                    : {}),
                  ...(result.payload?.cli_flag
                    ? { cli_flag: result.payload.cli_flag }
                    : {}),
                  ...(result.payload?.retry_policy
                    ? { retry_policy: result.payload.retry_policy }
                    : {}),
                }
              : {}),
          });
        }

        emit(ctx.out, jobIds.length === 1 ? rows[0] : rows, (o) => {
          for (const row of rows) {
            if (row.status === "failed") {
              note(
                o,
                fmt.red(o, `${row.job_id} failed: ${row.error ?? "unknown"}`),
              );
              const retryHint = seedanceRealPersonRetryHint(row);
              if (retryHint) note(o, fmt.dim(o, retryHint));
              continue;
            }
            for (const url of row.outputs) process.stdout.write(`${url}\n`);
            for (const f of row.downloaded_files ?? [])
              note(o, fmt.dim(o, savedLine(f)));
          }
        });
        if (failures > 0) process.exitCode = 1;
      } catch (err) {
        spin.stop();
        throw err;
      }
    });

  program
    .command("generations")
    .description("List recent + in-flight generations (AI Studio history)")
    .option("--type <type>", "image | video | sounds")
    .option("--status <status>", "pending | processing | completed | failed")
    .option(
      "--session <id>",
      "scope to an AI Studio session (incl. shared; env VIDEODRAFT_SESSION)",
      process.env.VIDEODRAFT_SESSION,
    )
    .option("--project <id>", "scope to a project's generations")
    .option("--model <id>", "filter by exact model id")
    .option("--favorites", "only starred generations")
    .option("--full", "include full parameters (JSON output)")
    .option("--limit <n>", "max rows (default 30)")
    .option("--offset <n>", "pagination offset (default 0)")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const result: any = await ctx.client.callTool(
        "list_recent_generations",
        compact({
          type: opts.type,
          status: opts.status,
          session_id: sessionArg(this, opts),
          project_id: opts.project,
          model: opts.model,
          favorites_only: opts.favorites ? true : undefined,
          view: opts.full ? "full" : undefined,
          limit: opts.limit ? Number(opts.limit) : undefined,
          offset: opts.offset ? Number(opts.offset) : undefined,
        }),
      );
      const rows: any[] = result?.generations ?? result?.items ?? [];
      emit(ctx.out, result, (o) => {
        table(
          o,
          ["id", "type", "status", "model", "fav", "created"],
          rows.map((g: any) => [
            String(g.id ?? g.job_id ?? ""),
            String(g.type ?? ""),
            String(g.status ?? ""),
            String(g.model ?? "").slice(0, 24),
            g.isFavorite ? "★" : "",
            String(g.created_at ?? g.createdAt ?? "").slice(0, 19),
          ]),
        );
        if (result?.inFlight !== undefined)
          note(o, fmt.dim(o, `In flight: ${result.inFlight}`));
      });
    });

  program
    .command("generation <generation_id>")
    .description(
      "Show one generation's full recipe (prompt, model, parameters, outputs), or star/unstar it",
    )
    .option("--favorite", "star this generation")
    .option("--unfavorite", "remove the star")
    .action(async function (this: Command, generationId: string) {
      const ctx = buildContext(this);
      const opts = this.opts<{ favorite?: boolean; unfavorite?: boolean }>();
      if (opts.favorite && opts.unfavorite) {
        throw new CliError(
          "Pass --favorite or --unfavorite, not both.",
          EXIT.USAGE,
        );
      }
      if (opts.favorite || opts.unfavorite) {
        const favorite = !!opts.favorite;
        const result = await ctx.client.callTool("set_generation_favorite", {
          generation_id: generationId,
          favorite,
        });
        emit(ctx.out, result, (o) =>
          note(o, favorite ? "Starred." : "Unstarred."),
        );
        return;
      }
      const result: any = await ctx.client.callTool("get_generation", {
        generation_id: generationId,
      });
      const g = result?.generation ?? result;
      emit(ctx.out, result, (o) => {
        note(
          o,
          `${g?.id ?? generationId}: ${g?.status ?? "unknown"}${g?.isFavorite ? " ★" : ""}`,
        );
        note(o, `${g?.type ?? ""} · ${g?.model ?? ""}`);
        if (g?.prompt) note(o, `prompt: ${g.prompt}`);
        if (g?.inputImageUrl) note(o, `input: ${g.inputImageUrl}`);
        if (g?.parameters && Object.keys(g.parameters).length > 0) {
          note(o, fmt.dim(o, `parameters: ${JSON.stringify(g.parameters)}`));
        }
        // Older servers forward raw JSONB entries where legacy rows hold
        // {url, thumbnails} objects instead of strings.
        const urls = (Array.isArray(g?.outputUrls) ? g.outputUrls : [])
          .map((u: any) => (typeof u === "string" ? u : u?.url))
          .filter((u: any) => typeof u === "string" && u.length > 0);
        for (const url of urls) process.stdout.write(`${url}\n`);
      });
    });
}
