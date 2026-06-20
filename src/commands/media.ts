/**
 * `videodraft upload | media | download`
 */

import type { Command } from "commander";
import { buildContext, compact } from "../cli/context.js";
import { emit, fmt, note, table } from "../cli/output.js";
import { uploadFile } from "../core/upload.js";
import { downloadUrl, extFromUrl, renderTemplate } from "../core/download.js";
import { capture } from "../cli/telemetry.js";

export function registerMediaCommands(program: Command): void {
  program
    .command("upload <file>")
    .description("Upload a local image/video/audio file; prints the public CDN URL")
    .option("--content-type <mime>", "MIME override when the extension is ambiguous")
    .action(async function (this: Command, file: string) {
      const ctx = buildContext(this);
      capture("cli_upload");
      const result = await uploadFile(ctx.client, file, {
        contentType: this.opts<any>().contentType,
      });
      emit(ctx.out, result, (o) => {
        process.stdout.write(`${result.url}\n`);
        note(o, fmt.dim(o, "Use this URL anywhere a public media URL is accepted (--ref, --start-image, ...)"));
      });
    });

  const media = program.command("media").description("Your media library");

  media
    .command("list", { isDefault: true })
    .description("List media library items")
    .option("--type <type>", "image | video | audio")
    .option("--limit <n>", "max rows")
    .option("--offset <n>", "pagination offset")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const opts = this.opts<any>();
      const result: any = await ctx.client.callTool(
        "list_media",
        compact({
          type: opts.type,
          limit: opts.limit ? Number(opts.limit) : undefined,
          offset: opts.offset ? Number(opts.offset) : undefined,
        }),
      );
      const rows: any[] = result?.media ?? result?.items ?? [];
      emit(ctx.out, result, (o) => {
        table(
          o,
          ["type", "url", "created"],
          rows.map((m: any) => [
            String(m.type ?? m.media_type ?? ""),
            String(m.url ?? m.cdn_url ?? m.public_url ?? "").slice(0, 80),
            String(m.createdAt ?? m.created_at ?? "").slice(0, 19),
          ]),
        );
      });
    });

  program
    .command("describe <url|file>")
    .description("Describe an image with a vision model (local files are uploaded first)")
    .action(async function (this: Command, source: string) {
      const ctx = buildContext(this);
      let url = source;
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
        url = (await uploadFile(ctx.client, source)).url;
      }
      capture("cli_describe");
      const result: any = await ctx.client.callTool("describe_image", { image_url: url });
      emit(ctx.out, result, (o) => {
        const text = result?.description ?? result?.text ?? JSON.stringify(result);
        process.stdout.write(`${text}\n`);
      });
    });

  program
    .command("download <url>")
    .description("Download a (CDN) URL to a local file")
    .option("-o, --output <path>", "output file or directory (default: basename in cwd)")
    .action(async function (this: Command, url: string) {
      const ctx = buildContext(this);
      const template = this.opts<any>().output ?? ".";
      const dest = renderTemplate(template, {
        index: 0,
        ext: extFromUrl(url),
        name: new URL(url).pathname.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "download",
      });
      const file = await downloadUrl(url, dest);
      emit(ctx.out, file, (o) => note(o, fmt.green(o, `saved ${file.path} (${file.bytes} bytes)`)));
    });
}
