/**
 * `videodraft stock search | import`
 *
 * Free, watermark-free footage and photos from Pexels and Pixabay. Search
 * returns refs; import copies the file onto the VideoDraft CDN and prints the
 * URL, which is what every other command accepts as media.
 */

import type { Command } from "commander";
import { buildContext, compact } from "../cli/context.js";
import { emit, fmt, note, table } from "../cli/output.js";
import { capture } from "../cli/telemetry.js";
import { buildMediaDescriptors } from "../core/media.js";
import { UsageError } from "../core/errors.js";

const TYPES = ["video", "image", "all"];
const ORIENTATIONS = ["landscape", "portrait", "square", "any"];
const PROVIDERS = ["pexels", "pixabay", "all"];
const QUALITIES = ["sd", "hd", "4k", "best"];

function assertOneOf(
  value: string | undefined,
  allowed: string[],
  flag: string,
): void {
  if (value && allowed.indexOf(value) === -1) {
    throw new UsageError(`${flag} must be one of: ${allowed.join(", ")}`);
  }
}

export function registerStockCommands(program: Command): void {
  const stock = program
    .command("stock")
    .description("Free stock footage and photos (Pexels, Pixabay)");

  stock
    .command("search <query...>", { isDefault: true })
    .description("Search free stock media; prints refs for `stock import`")
    .option("--type <type>", `${TYPES.join(" | ")} (default: video)`)
    .option("--orientation <o>", `${ORIENTATIONS.join(" | ")}`)
    .option("--provider <p>", `${PROVIDERS.join(" | ")}`)
    .option("--min-duration <s>", "drop clips shorter than this many seconds")
    .option("--max-duration <s>", "drop clips longer than this many seconds")
    .option(
      "--min-resolution <px>",
      "drop items whose long edge is smaller than this, e.g. 1920",
    )
    .option("--limit <n>", "results per provider per media type (1-30)")
    .option("--page <n>", "page of results")
    .action(async function (this: Command, query: string[]) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      assertOneOf(opts.type, TYPES, "--type");
      assertOneOf(opts.orientation, ORIENTATIONS, "--orientation");
      assertOneOf(opts.provider, PROVIDERS, "--provider");
      capture("cli_stock_search");

      const result: any = await ctx.client.callTool(
        "search_stock_media",
        compact({
          query: query.join(" "),
          type: opts.type,
          orientation: opts.orientation,
          provider: opts.provider,
          min_duration_seconds: opts.minDuration
            ? Number(opts.minDuration)
            : undefined,
          max_duration_seconds: opts.maxDuration
            ? Number(opts.maxDuration)
            : undefined,
          min_resolution: opts.minResolution
            ? Number(opts.minResolution)
            : undefined,
          limit: opts.limit ? Number(opts.limit) : undefined,
          page: opts.page ? Number(opts.page) : undefined,
        }),
      );

      const rows: any[] = result?.results ?? [];
      emit(ctx.out, result, (o) => {
        table(
          o,
          ["ref", "dur", "max", "by", "title"],
          rows.map((r: any) => [
            String(r.ref ?? ""),
            r.duration_seconds ? `${r.duration_seconds}s` : "-",
            r.max_rendition?.label ? String(r.max_rendition.label) : "-",
            String(r.author ?? "").slice(0, 24),
            String(r.title ?? "").slice(0, 44),
          ]),
        );
        note(
          o,
          fmt.dim(
            o,
            "Free, no credits. Copy one onto the CDN with: videodraft stock import <ref>",
          ),
        );
        note(
          o,
          fmt.dim(
            o,
            "Credit the creator and link the provider page when you publish.",
          ),
        );
      });
    });

  stock
    .command("import <ref>")
    .description("Copy a stock item onto the VideoDraft CDN; prints the URL")
    .option("--quality <q>", `${QUALITIES.join(" | ")} (default: hd)`)
    .action(async function (this: Command, ref: string) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      assertOneOf(opts.quality, QUALITIES, "--quality");
      capture("cli_stock_import");

      const raw: any = await ctx.client.callTool(
        "import_stock_media",
        compact({ ref, quality: opts.quality }),
      );
      // Same descriptor contract as every other media-producing command, so
      // ADE can render the imported clip.
      const result = {
        ...raw,
        output_media: buildMediaDescriptors([raw?.url], raw?.media_type),
      };

      emit(ctx.out, result, (o) => {
        process.stdout.write(`${result.url}\n`);
        const source = result?.source ?? {};
        note(
          o,
          fmt.dim(
            o,
            `${result.rendition ?? ""} ${result.width}x${result.height}` +
              (result.duration_seconds ? ` ${result.duration_seconds}s` : ""),
          ),
        );
        if (source.attribution) {
          note(
            o,
            fmt.dim(o, `${source.attribution}. ${source.page_url ?? ""}`),
          );
        }
      });
    });
}
