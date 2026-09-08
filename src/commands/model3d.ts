/** Standalone 3D generation and rigging, with complete artifact-package downloads. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
  buildContext,
  collect,
  compact,
  sessionProfileKey,
  type CommandContext,
} from "../cli/context.js";
import { emit, fmt, note, spinner, table } from "../cli/output.js";
import { CliError, EXIT } from "../core/errors.js";
import { pollGeneration } from "../core/poll.js";
import { uploadFile, upload3DFile } from "../core/upload.js";
import { savedLine } from "../core/download.js";
import {
  downloadModel3DPackage,
  model3DOutputFields,
} from "../core/model3d.js";
import {
  localReferenceIdentity,
  prepare3DRequest,
  normalize3DUuid,
} from "../core/model3d-request.js";
import { coerceArgValue } from "./tools.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type InputMode = "text" | "image" | "multi_image";

/** Preserve provider-native keys and JSON values, including false and zero. */
export function parse3DOptions(
  raw?: string,
  pairs: string[] = [],
): Record<string, unknown> {
  let parsed: unknown = {};
  if (raw !== undefined) {
    try {
      parsed = JSON.parse(
        raw.startsWith("@") ? fs.readFileSync(raw.slice(1), "utf8") : raw,
      );
    } catch (error) {
      throw new CliError(
        `--options must be JSON or @path.json: ${error instanceof Error ? error.message : String(error)}`,
        EXIT.USAGE,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CliError("--options must be a JSON object.", EXIT.USAGE);
    }
  }
  const options = { ...(parsed as Record<string, unknown>) };
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator < 1)
      throw new CliError(
        `--option expects key=value, got: ${pair}`,
        EXIT.USAGE,
      );
    const key = pair.slice(0, separator).trim();
    if (!key || ["__proto__", "constructor", "prototype"].includes(key)) {
      throw new CliError(`Invalid --option key: ${key}`, EXIT.USAGE);
    }
    options[key] = coerceArgValue(pair.slice(separator + 1));
  }
  return options;
}

export function infer3DInputMode(
  explicit: string | undefined,
  refs: string[],
  prompt?: string,
): InputMode {
  const mode =
    explicit ??
    (refs.length > 1 ? "multi_image" : refs.length === 1 ? "image" : "text");
  if (!["text", "image", "multi_image"].includes(mode)) {
    throw new CliError(
      "--input-mode must be text, image, or multi_image.",
      EXIT.USAGE,
    );
  }
  if (mode === "text" && (!prompt?.trim() || refs.length > 0)) {
    throw new CliError(
      "Text-to-3D requires a prompt and no --ref images.",
      EXIT.USAGE,
    );
  }
  if (mode !== "text" && prompt !== undefined) {
    throw new CliError(
      "Image-to-3D inputs do not accept a geometry prompt. For Meshy texturing guidance, use --option texture_prompt=...",
      EXIT.USAGE,
    );
  }
  if (mode === "image" && refs.length !== 1) {
    throw new CliError(
      "Image-to-3D requires exactly one --ref image.",
      EXIT.USAGE,
    );
  }
  if (mode === "multi_image" && refs.length < 1) {
    throw new CliError(
      "Multi-image-to-3D requires at least one --ref image. See models 3d --json for per-model view limits.",
      EXIT.USAGE,
    );
  }
  return mode as InputMode;
}

function requestId(value?: string): string {
  if (value !== undefined && !UUID_RE.test(value))
    throw new CliError("--request-id must be a UUID.", EXIT.USAGE);
  return (value ?? randomUUID()).toLowerCase();
}

function requestScope(ctx: CommandContext): string {
  return `${ctx.baseUrl}\n${sessionProfileKey(ctx.profileName, ctx.flags.token ?? process.env.VIDEODRAFT_API_KEY)}`;
}

function validateLocalImage(ref: string): void {
  if (/^https?:\/\//i.test(ref)) return;
  if (!fs.existsSync(ref) || !fs.statSync(ref).isFile())
    throw new CliError(
      `Reference is neither a public HTTP(S) URL nor a local image file: ${ref}`,
      EXIT.USAGE,
    );
  if (!/\.(png|jpe?g|webp|gif|avif|heic)$/i.test(ref))
    throw new CliError(
      `3D generation references must be images: ${ref}`,
      EXIT.USAGE,
    );
}

function commonOptions(command: Command): Command {
  return command
    .option(
      "--options <json|@file>",
      "exact Fal options as a JSON object; see models 3d --json",
    )
    .option(
      "--option <key=value>",
      "repeatable Fal option; values accept JSON and override --options",
      collect,
      [],
    )
    .option(
      "--project <id>",
      "associate the saved asset with an existing project",
    )
    .option(
      "--request-id <uuid>",
      "idempotency key for a safe retry; generated once when omitted",
    )
    .option(
      "--estimate",
      "quote the selected options without uploading files or spending credits",
    )
    .option("--no-wait", "return the saved job id immediately")
    .option(
      "--download [directory]",
      "download every artifact plus manifest (default media/3d/<asset_id>)",
    );
}

/** Exported for status/get so every path uses the same file/media contract. */
export async function emit3DResult(
  ctx: CommandContext,
  payload: any,
  download?: string | true,
): Promise<void> {
  const result = {
    ...payload,
    type: "model3d",
    ...model3DOutputFields(payload),
  };
  const packageResult =
    download && payload?.status === "completed"
      ? await downloadModel3DPackage(result, download)
      : undefined;
  emit(ctx.out, { ...result, ...packageResult }, (out) => {
    note(
      out,
      `${payload?.asset_id ?? payload?.job_id ?? "3D asset"}: ${payload?.status ?? "unknown"}`,
    );
    if (payload?.request_id)
      note(out, fmt.dim(out, `Request ID: ${payload.request_id}`));
    if (payload?.credits !== undefined)
      note(
        out,
        payload.byok
          ? "Your Fal key (0 VideoDraft credits)."
          : `Credits: ${payload.credits_charged ?? payload.credits}${payload.billing_status === "refunded" ? " (refunded)" : ""}`,
      );
    if (payload?.status === "failed")
      note(
        out,
        fmt.red(out, String(payload?.error ?? "3D generation failed.")),
      );
    for (const artifact of result.output_files)
      process.stdout.write(`${artifact.url}\n`);
    for (const file of packageResult?.downloaded_files ?? [])
      note(out, fmt.dim(out, savedLine(file)));
    if (packageResult)
      note(out, fmt.dim(out, `Manifest: ${packageResult.manifest_path}`));
    for (const warning of packageResult?.package_warnings ??
      result.package_warnings)
      note(out, fmt.yellow(out, warning));
    if (payload?.job_id && !["completed", "failed"].includes(payload.status))
      note(
        out,
        fmt.dim(
          out,
          `Resume with: videodraft wait ${payload.job_id} --download`,
        ),
      );
  });
  if (payload?.status === "failed") process.exitCode = 1;
}

async function submit3D(
  ctx: CommandContext,
  tool: "generate_3d" | "rig_3d",
  args: Record<string, unknown>,
  opts: { wait: boolean; download?: string | true },
): Promise<void> {
  const id = String(args.request_id);
  note(
    ctx.out,
    fmt.dim(
      ctx.out,
      `Request ID: ${id} (reuse --request-id ${id} if submission is interrupted).`,
    ),
  );
  let submitted: any;
  try {
    submitted = await ctx.client.callTool(tool, args);
  } catch (error) {
    // The caller needs the id even if the provider accepted a request whose reply was lost.
    if (error instanceof CliError) {
      throw new CliError(
        error.message,
        error.exitCode,
        `Retry the same command with --request-id ${id}.`,
        {
          ...(error.data && typeof error.data === "object" ? error.data : {}),
          request_id: id,
        },
      );
    }
    throw new CliError(
      error instanceof Error ? error.message : String(error),
      EXIT.ERROR,
      `Retry the same command with --request-id ${id}.`,
      { request_id: id },
    );
  }
  submitted = { ...submitted, request_id: id, type: "model3d" };
  if (
    !opts.wait ||
    !submitted.job_id ||
    ["completed", "failed"].includes(submitted.status)
  ) {
    await emit3DResult(ctx, submitted, opts.download);
    return;
  }
  const spin = spinner(ctx.out, `3D job ${submitted.job_id}`);
  try {
    const result = await pollGeneration(ctx.client, submitted.job_id, {
      intervalMs: ctx.intervalMs,
      timeoutMs: ctx.timeoutMs,
      adaptive: ctx.adaptive,
      onTick: (status) => spin.update(`3D job ${submitted.job_id}: ${status}`),
    });
    spin.stop();
    await emit3DResult(
      ctx,
      { ...submitted, ...result.payload, request_id: id },
      opts.download,
    );
  } catch (error) {
    spin.stop();
    throw error;
  }
}

export function register3DGenerationCommand(generate: Command): void {
  commonOptions(
    generate
      .command("3d [prompt]")
      .description(
        "Generate a saved 3D asset through Fal (Meshy 7 or Tripo H3.1)",
      )
      .option("--model <id>", "meshy-7 | tripo-h3.1", "meshy-7")
      .option(
        "--input-mode <mode>",
        "text | image | multi_image; inferred from references by default",
      )
      .option(
        "--ref <url|file>",
        "reference image, repeat in the order required by the model",
        collect,
        [],
      ),
  ).action(async function (this: Command, prompt?: string) {
    const ctx = buildContext(this);
    const opts = this.opts<any>();
    if (!["meshy-7", "tripo-h3.1"].includes(opts.model))
      throw new CliError(
        "--model must be meshy-7 or tripo-h3.1. Use models 3d --json for the live catalog.",
        EXIT.USAGE,
      );
    const refs: string[] = opts.ref;
    const mode = infer3DInputMode(opts.inputMode, refs, prompt);
    const minimumViews = opts.model === "tripo-h3.1" ? 2 : 1;
    if (
      mode === "multi_image" &&
      (refs.length < minimumViews || refs.length > 4)
    ) {
      throw new CliError(
        `${opts.model} multi-image input requires ${minimumViews}-4 --ref images. Tripo order: front, left, back, right.`,
        EXIT.USAGE,
      );
    }
    refs.forEach(validateLocalImage);
    const options = parse3DOptions(opts.options, opts.option);
    const id = requestId(opts.requestId);
    if (opts.estimate) {
      const estimate = await ctx.client.callTool(
        "estimate_3d",
        compact({
          operation: "generate",
          model: opts.model,
          input_mode: mode,
          prompt,
          image_count: refs.length || undefined,
          options,
        }),
      );
      emit(ctx.out, {
        estimate,
        note: "No credits were spent and no files were uploaded (--estimate).",
      });
      return;
    }
    const prepared = await prepare3DRequest(
      requestScope(ctx),
      id,
      {
        operation: "generate",
        model: opts.model,
        input_mode: mode,
        prompt,
        refs: refs.map(localReferenceIdentity),
        options,
        project_id: normalize3DUuid(opts.project),
      },
      async () => {
        const images: string[] = [];
        for (const ref of refs) {
          if (/^https?:\/\//i.test(ref)) images.push(ref);
          else {
            note(ctx.out, fmt.dim(ctx.out, `Uploading ${ref}...`));
            images.push((await uploadFile(ctx.client, ref)).url);
          }
        }
        return compact({
          model: opts.model,
          input_mode: mode,
          prompt,
          image_url: mode === "image" ? images[0] : undefined,
          image_urls: mode === "multi_image" ? images : undefined,
          options,
          request_id: id,
          project_id: normalize3DUuid(opts.project),
        });
      },
    );
    if (prepared.reused)
      note(
        ctx.out,
        fmt.dim(
          ctx.out,
          `Reusing saved request ${id} and its uploaded references.`,
        ),
      );
    await submit3D(ctx, "generate_3d", prepared.args, opts);
  });
}

function pagination(
  value: string | undefined,
  label: string,
  min: number,
): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min)
    throw new CliError(
      `${label} must be an integer of at least ${min}.`,
      EXIT.USAGE,
    );
  return number;
}

export function register3DAssetCommands(program: Command): void {
  const rig = program
    .command("rig")
    .description("Rig compatible 3D characters");
  commonOptions(
    rig
      .command("3d [model]")
      .description(
        "Rig a textured humanoid GLB through Meshy, with available preset animation",
      )
      .option(
        "--asset <id>",
        "saved 3D asset id instead of a model URL or local GLB",
      ),
  ).action(async function (this: Command, model?: string) {
    const ctx = buildContext(this);
    const opts = this.opts<any>();
    if (model && opts.asset)
      throw new CliError(
        "Pass a model URL/file or --asset, not both.",
        EXIT.USAGE,
      );
    if (!model && !opts.asset && !opts.estimate)
      throw new CliError(
        "Pass a model URL/local GLB or --asset <id>.",
        EXIT.USAGE,
      );
    if (
      model &&
      !/^https?:\/\//i.test(model) &&
      (!fs.existsSync(model) ||
        !fs.statSync(model).isFile() ||
        path.extname(model).toLowerCase() !== ".glb")
    )
      throw new CliError(
        "Rigging input must be a public HTTP(S) URL or a local .glb file.",
        EXIT.USAGE,
      );
    const options = parse3DOptions(opts.options, opts.option);
    const id = requestId(opts.requestId);
    if (opts.estimate) {
      const estimate = await ctx.client.callTool("estimate_3d", {
        operation: "rig",
        options,
      });
      emit(ctx.out, {
        estimate,
        note: "No credits were spent and no files were uploaded (--estimate).",
      });
      return;
    }
    const prepared = await prepare3DRequest(
      requestScope(ctx),
      id,
      {
        operation: "rig",
        model: model ? localReferenceIdentity(model) : undefined,
        asset_id: normalize3DUuid(opts.asset),
        options,
        project_id: normalize3DUuid(opts.project),
      },
      async () => {
        const url =
          model && !/^https?:\/\//i.test(model)
            ? (await upload3DFile(ctx.client, model)).url
            : model;
        return compact({
          model_url: url,
          asset_id: normalize3DUuid(opts.asset),
          options,
          request_id: id,
          project_id: normalize3DUuid(opts.project),
        });
      },
    );
    if (prepared.reused)
      note(
        ctx.out,
        fmt.dim(ctx.out, `Reusing saved request ${id} and its uploaded model.`),
      );
    await submit3D(ctx, "rig_3d", prepared.args, opts);
  });

  const assets = program
    .command("assets")
    .description("Saved standalone assets")
    .command("3d")
    .description("Saved 3D model packages");
  assets
    .command("list")
    .description("List saved 3D jobs and assets")
    .option("--model <id>", "filter by generation model")
    .option("--project <id>", "filter by project")
    .option("--status <status>", "pending | processing | completed | failed")
    .option("--limit <n>", "maximum results")
    .option("--offset <n>", "pagination offset")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const result: any = await ctx.client.callTool(
        "list_3d_assets",
        compact({
          model: opts.model,
          project_id: normalize3DUuid(opts.project),
          status: opts.status,
          limit: pagination(opts.limit, "--limit", 1),
          offset: pagination(opts.offset, "--offset", 0),
        }),
      );
      emit(ctx.out, result, (out) => {
        const rows: any[] = result?.assets ?? result?.items ?? [];
        table(
          out,
          ["job_id / asset_id", "status", "model", "created"],
          rows.map((row) => [
            String(row.asset_id ?? row.job_id ?? row.id ?? ""),
            String(row.status ?? ""),
            String(row.model ?? ""),
            String(row.created_at ?? ""),
          ]),
        );
      });
    });
  assets
    .command("get <asset_id>")
    .description("Get a 3D asset and optionally download its full package")
    .option(
      "--download [directory]",
      "download artifacts plus manifest (default media/3d/<asset_id>)",
    )
    .action(async function (this: Command, assetId: string) {
      assetId = normalize3DUuid(assetId)!;
      const ctx = buildContext(this);
      const result: any = await ctx.client.callTool("get_3d_asset", {
        asset_id: assetId,
      });
      await emit3DResult(
        ctx,
        { ...(result?.asset ?? result), asset_id: assetId },
        this.opts<any>().download,
      );
    });
}
