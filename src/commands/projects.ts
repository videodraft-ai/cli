/**
 * `videodraft projects ...` and `videodraft checkpoint ...`
 */

import { spawn } from "node:child_process";
import type { Command } from "commander";
import { buildContext, compact } from "../cli/context.js";
import { emit, fmt, note, table } from "../cli/output.js";
import { CliError, EXIT } from "../core/errors.js";

export function registerProjectCommands(program: Command): void {
  const projects = program.command("projects").description("List and manage projects");

  projects
    .command("list", { isDefault: true })
    .description("List projects")
    .option("--limit <n>", "max projects (default 50)")
    .option("--offset <n>", "pagination offset")
    .option("--favorites", "only favorited projects")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const opts = this.opts<{ limit?: string; offset?: string; favorites?: boolean }>();
      const result: any = await ctx.client.callTool(
        "list_projects",
        compact({
          limit: opts.limit ? Number(opts.limit) : undefined,
          offset: opts.offset ? Number(opts.offset) : undefined,
          favorites_only: opts.favorites || undefined,
        }),
      );
      const rows: any[] = result?.projects ?? [];
      emit(ctx.out, result, (o) => {
        table(
          o,
          ["id", "title", "status", "modified"],
          rows.map((p: any) => [
            String(p.id ?? ""),
            String(p.title ?? "Untitled").slice(0, 44),
            String(p.status ?? ""),
            String(p.lastModified ?? "").slice(0, 19),
          ]),
        );
      });
    });

  projects
    .command("get <project_id>")
    .description("Fetch a project (summary view; --raw for the editable blob)")
    .option("--raw", "return the raw editable JSON blob")
    .action(async function (this: Command, projectId: string) {
      const ctx = buildContext(this);
      const result = await ctx.client.callTool("get_project", {
        project_id: projectId,
        view: this.opts<{ raw?: boolean }>().raw ? "raw" : "summary",
      });
      emit(ctx.out, result);
    });

  projects
    .command("delete <project_id>")
    .description("Permanently delete a project (cannot be undone)")
    .option("--yes", "skip the confirmation")
    .action(async function (this: Command, projectId: string) {
      const ctx = buildContext(this);
      if (!this.opts<{ yes?: boolean }>().yes) {
        throw new CliError(
          "Refusing to delete without --yes. Deletion is permanent for every collaborator.",
          EXIT.USAGE,
        );
      }
      const result = await ctx.client.callTool("delete_project", { project_id: projectId });
      emit(ctx.out, result, (o) => note(o, fmt.green(o, `Deleted project ${projectId}.`)));
    });

  projects
    .command("favorite <project_id>")
    .description("Star or unstar a project")
    .option("--remove", "unstar instead of star")
    .action(async function (this: Command, projectId: string) {
      const ctx = buildContext(this);
      const favorite = !this.opts<{ remove?: boolean }>().remove;
      const result = await ctx.client.callTool("set_project_favorite", {
        project_id: projectId,
        favorite,
      });
      emit(ctx.out, result, (o) => note(o, favorite ? "Starred." : "Unstarred."));
    });

  projects
    .command("open <project_id>")
    .description("Open the project in your browser")
    .action(async function (this: Command, projectId: string) {
      const ctx = buildContext(this);
      const result: any = await ctx.client.callTool("get_project", {
        project_id: projectId,
        view: "summary",
      });
      const url: string =
        result?.urls?.storyboard ?? result?.urls?.script ?? `${ctx.baseUrl}/projects/${projectId}`;
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      try {
        const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
        child.on("error", () => {}); // headless: no opener — URL is printed below
        child.unref();
      } catch {
        // printed below either way
      }
      emit(ctx.out, { url }, (o) => note(o, url));
    });

  const checkpoint = program.command("checkpoint").description("Project version checkpoints");

  checkpoint
    .command("create <project_id>")
    .description("Snapshot the project as a new version")
    .option("--name <name>", "version name")
    .option("--description <text>", "version description")
    .action(async function (this: Command, projectId: string) {
      const ctx = buildContext(this);
      const opts = this.opts<{ name?: string; description?: string }>();
      const result = await ctx.client.callTool(
        "create_project_checkpoint",
        compact({ project_id: projectId, name: opts.name, description: opts.description }),
      );
      emit(ctx.out, result);
    });

  checkpoint
    .command("list <project_id>")
    .description("List a project's checkpoints")
    .action(async function (this: Command, projectId: string) {
      const ctx = buildContext(this);
      const result = await ctx.client.callTool("list_project_checkpoints", { project_id: projectId });
      emit(ctx.out, result);
    });

  checkpoint
    .command("restore <project_id> [version_number]")
    .description("Restore a project to a saved version (current state is snapshotted first)")
    .option("--checkpoint-id <id>", "restore by checkpoint UUID instead of version number")
    .action(async function (this: Command, projectId: string, versionNumber?: string) {
      const ctx = buildContext(this);
      const opts = this.opts<{ checkpointId?: string }>();
      if (!versionNumber && !opts.checkpointId) {
        throw new CliError("Pass a version_number or --checkpoint-id.", EXIT.USAGE);
      }
      const result = await ctx.client.callTool(
        "restore_project_checkpoint",
        compact({
          project_id: projectId,
          version_number: versionNumber ? Number(versionNumber) : undefined,
          checkpoint_id: opts.checkpointId,
        }),
      );
      emit(ctx.out, result);
    });
}
