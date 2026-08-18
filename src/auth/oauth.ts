/**
 * OAuth 2.1 authorization-code + PKCE flow against the VideoDraft AS,
 * using an RFC 8252 loopback redirect (http://127.0.0.1:<ephemeral-port>/callback).
 *
 * Server contract (app/api/oauth/* in the VideoDraft app):
 *   GET  /api/oauth/authorize  ?response_type=code&client_id&redirect_uri&scope
 *                              &state&code_challenge&code_challenge_method=S256&resource
 *   POST /api/oauth/token      form or JSON; authorization_code | refresh_token grants
 *   POST /api/oauth/register   RFC 7591 DCR (https or http-loopback redirect URIs only)
 *   POST /api/oauth/revoke     RFC 7009
 *
 * Client identity: the static public client `vd_client_cli` (pre-registered in
 * oauth_clients — see sql/ in this repo). When that id is missing on the target
 * server (e.g. a fresh local stack), we fall back to Dynamic Client Registration
 * and persist the issued client_id in the profile.
 */

import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { CliError } from "../core/errors.js";

export const STATIC_CLI_CLIENT_ID = "vd_client_cli";
export const OAUTH_SCOPE = "mcp";

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(params: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL("/api/oauth/authorize", params.baseUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", `${params.baseUrl}/api/mcp`);
  return url.toString();
}

/**
 * Is this client_id known to the server? The authorize endpoint renders a
 * non-redirect 400 HTML page for an unknown client, and 3xx-redirects to the
 * consent page for a valid request — probe with redirect:"manual" so we can
 * fall back to DCR before ever opening a browser tab on an error page.
 */
export async function probeClientId(
  baseUrl: string,
  clientId: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const { challenge } = createPkcePair();
  const url = buildAuthorizeUrl({
    baseUrl,
    clientId,
    redirectUri,
    state: "probe",
    codeChallenge: challenge,
  });
  const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  return res.status >= 300 && res.status < 400;
}

/** RFC 7591 dynamic registration fallback. Returns the issued client_id. */
export async function registerCliClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(new URL("/api/oauth/register", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "VideoDraft CLI",
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: OAUTH_SCOPE,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body?.client_id) {
    throw new CliError(
      `OAuth client registration failed: ${body?.error_description ?? body?.error ?? res.status}`,
    );
  }
  return body.client_id as string;
}

/**
 * Run the loopback listener + browser round trip and return the authorization
 * code. `onAuthorizeUrl` receives the URL to open (the command layer opens the
 * browser and prints it — this module stays headless/testable).
 */
export async function authorizeViaLoopback(params: {
  baseUrl: string;
  clientId: string;
  onAuthorizeUrl: (url: string) => void | Promise<void>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ code: string; redirectUri: string; verifier: string }> {
  const { verifier, challenge } = createPkcePair();
  const state = b64url(crypto.randomBytes(16));

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const codePromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new CliError("Timed out waiting for the browser login (5 minutes).")),
      params.timeoutMs ?? 300_000,
    );
    timeout.unref();

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");

      const page = (title: string, body: string) =>
        `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
        `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;text-align:center">` +
        `<h1 style="font-size:20px">${title}</h1><p style="color:#555">${body}</p></body></html>`;

      if (err) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("Login failed", `${err}. You can close this tab and return to the terminal.`));
        clearTimeout(timeout);
        reject(new CliError(`Authorization failed: ${err}`));
        return;
      }
      if (!code || gotState !== state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(page("Login failed", "Missing code or state mismatch. Close this tab and retry."));
        clearTimeout(timeout);
        reject(new CliError("Authorization response missing code or state mismatch."));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page("You're logged in to VideoDraft", "You can close this tab and return to the terminal."));
      clearTimeout(timeout);
      resolve(code);
    });
  });

  // The server handler may reject before the await below attaches — keep a
  // no-op handler on a branch so Node never sees an unhandled rejection.
  codePromise.catch(() => {});

  try {
    const authorizeUrl = buildAuthorizeUrl({
      baseUrl: params.baseUrl,
      clientId: params.clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
    });
    await params.onAuthorizeUrl(authorizeUrl);
    const code = await codePromise;
    return { code, redirectUri, verifier };
  } finally {
    server.close();
  }
}

export async function exchangeCode(params: {
  baseUrl: string;
  clientId: string;
  code: string;
  redirectUri: string;
  verifier: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(new URL("/api/oauth/token", params.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.verifier,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body?.access_token) {
    throw new CliError(
      `Token exchange failed: ${body?.error_description ?? body?.error ?? `HTTP ${res.status}`}`,
    );
  }
  return body as OAuthTokens;
}

export async function refreshAccessToken(params: {
  baseUrl: string;
  clientId: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens | null> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(new URL("/api/oauth/token", params.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: params.clientId,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const body: any = await res.json().catch(() => null);
  return body?.access_token ? (body as OAuthTokens) : null;
}

/** RFC 7009 revocation — best-effort, used by `videodraft logout`. */
export async function revokeToken(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(new URL("/api/oauth/revoke", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best-effort
  }
}
