/**
 * `videodraft login | logout | whoami`
 *
 * login default: browser OAuth (loopback). Headless paths:
 *   videodraft login --token vd_mcp_...     (PAT from /mcp-keys)
 *   videodraft login --with-token < file    (PAT on stdin)
 *   VIDEODRAFT_API_KEY=vd_mcp_...           (no login at all)
 */

import { spawn } from "node:child_process";
import type { Command } from "commander";
import { CliError, EXIT } from "../core/errors.js";
import { DEFAULT_BASE_URL, getProfile, updateConfig } from "../core/config.js";
import {
  authorizeViaLoopback,
  exchangeCode,
  probeClientId,
  registerCliClient,
  revokeToken,
  STATIC_CLI_CLIENT_ID,
} from "../auth/oauth.js";
import { VideoDraftClient } from "../core/rpc.js";
import { buildContext } from "../cli/context.js";
import { emit, fmt, kv, note, spinner } from "../cli/output.js";
import { capture } from "../cli/telemetry.js";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    // spawn emits 'error' asynchronously (e.g. xdg-open missing on headless
    // Linux), which the try/catch can't catch and would crash the process.
    // Swallow it — the login URL is printed for manual opening regardless.
    child.on("error", () => {});
    child.unref();
  } catch {
    // URL is printed regardless; manual open still works
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function saveProfile(
  profileName: string,
  profile: {
    base_url: string;
    auth_kind: "pat" | "oauth";
    access_token: string;
    refresh_token?: string;
    expires_at?: string;
    client_id?: string;
  },
): void {
  updateConfig((config) => {
    config.profiles[profileName] = profile;
    config.active_profile = profileName;
  });
}

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description("Authenticate with VideoDraft (browser login; --token for a PAT)")
    .option("--token <vd_mcp_token>", "use a personal access token from /mcp-keys instead of the browser")
    .option("--with-token", "read a personal access token from stdin")
    .option("--no-browser", "print the login URL instead of opening a browser")
    .action(async function (this: Command) {
      const opts = this.opts<{ token?: string; withToken?: boolean; browser?: boolean }>();
      const globals = this.optsWithGlobals<{ baseUrl?: string; profile?: string; json?: boolean }>();
      const baseUrl = (globals.baseUrl ?? process.env.VIDEODRAFT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
      const profileName = globals.profile ?? "default";
      const ctxOut = buildContext(this).out;

      // ── PAT paths ─────────────────────────────────────────────────────────
      let pat = opts.token;
      if (!pat && opts.withToken) pat = await readStdin();
      if (pat) {
        if (!pat.startsWith("vd_mcp_")) {
          throw new CliError("That does not look like a VideoDraft token (expected vd_mcp_...).", EXIT.USAGE);
        }
        const client = new VideoDraftClient({
          tokenProvider: { getAccessToken: async () => pat! },
          baseUrl,
        });
        const me: any = await client.callTool("whoami");
        saveProfile(profileName, { base_url: baseUrl, auth_kind: "pat", access_token: pat });
        capture("cli_login", { method: "pat" });
        emit(ctxOut, { ok: true, method: "pat", user: me }, (o) => {
          note(o, fmt.green(o, `Logged in as ${me?.email ?? me?.user_id ?? "user"} (PAT, ${baseUrl})`));
        });
        return;
      }

      // ── Browser OAuth (loopback) ──────────────────────────────────────────
      const existing = getProfile(profileName).profile;
      let clientId = existing?.client_id ?? process.env.VIDEODRAFT_OAUTH_CLIENT_ID ?? STATIC_CLI_CLIENT_ID;

      // Probe; fall back to DCR when the static client isn't seeded (local stacks).
      const known = await probeClientId(baseUrl, clientId, "http://127.0.0.1:1/callback").catch(() => false);
      if (!known) {
        note(ctxOut, fmt.dim(ctxOut, `OAuth client ${clientId} not registered on ${baseUrl} — registering one...`));
        clientId = await registerCliClient(baseUrl);
      }

      const spin = spinner(ctxOut, "Waiting for browser login…");
      try {
        const { code, redirectUri, verifier } = await authorizeViaLoopback({
          baseUrl,
          clientId,
          onAuthorizeUrl: (url) => {
            if (opts.browser !== false) openBrowser(url);
            note(ctxOut, `\n${fmt.bold(ctxOut, "Open this URL to log in:")}\n  ${url}\n`);
          },
        });
        spin.update("Exchanging authorization code…");
        const tokens = await exchangeCode({ baseUrl, clientId, code, redirectUri, verifier });
        saveProfile(profileName, {
          base_url: baseUrl,
          auth_kind: "oauth",
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          client_id: clientId,
        });
        spin.stop();

        const client = new VideoDraftClient({
          tokenProvider: { getAccessToken: async () => tokens.access_token },
          baseUrl,
        });
        const me: any = await client.callTool("whoami").catch(() => null);
        capture("cli_login", { method: "oauth" });
        emit(ctxOut, { ok: true, method: "oauth", user: me }, (o) => {
          note(o, fmt.green(o, `Logged in as ${me?.email ?? "user"} (${baseUrl})`));
          note(o, fmt.dim(o, "Tokens stored in " + `${process.env.VIDEODRAFT_CONFIG_DIR ?? "~/.config/videodraft"}/config.json`));
        });
      } catch (err) {
        spin.stop();
        throw err;
      }
    });

  program
    .command("logout")
    .description("Revoke the current OAuth grant (best-effort) and clear stored credentials")
    .action(async function (this: Command) {
      const globals = this.optsWithGlobals<{ profile?: string; json?: boolean }>();
      const ctxOut = buildContext(this).out;
      // Resolve via getProfile so an omitted --profile targets the ACTIVE
      // profile (config.active_profile), not the literal "default" — otherwise
      // `logout` could leave the in-use credentials untouched.
      const { name: profileName, profile } = getProfile(globals.profile);
      if (!profile) {
        emit(ctxOut, { ok: true, message: "No stored credentials." }, (o) => note(o, "No stored credentials."));
        return;
      }
      if (profile.auth_kind === "oauth") {
        await revokeToken(profile.base_url, profile.access_token);
        if (profile.refresh_token) await revokeToken(profile.base_url, profile.refresh_token);
      }
      updateConfig((config) => {
        delete config.profiles[profileName];
      });
      capture("cli_logout");
      emit(ctxOut, { ok: true }, (o) => {
        note(o, fmt.green(o, "Logged out."));
        if (profile.auth_kind === "pat") {
          note(o, fmt.dim(o, "PATs are revoked from the web app: https://app.videodraft.ai/mcp-keys"));
        }
      });
    });

  program
    .command("whoami")
    .description("Show the authenticated VideoDraft user")
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const me: any = await ctx.client.callTool("whoami");
      emit(ctx.out, me, (o) => {
        kv(o, [
          ["User", me?.email ?? me?.user_id],
          ["User id", me?.user_id ?? me?.id],
          ["Workspace", me?.workspace_id ?? me?.workspace ?? "personal"],
          ["Server", ctx.baseUrl],
        ]);
      });
    });
}
