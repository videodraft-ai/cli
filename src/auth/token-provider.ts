/**
 * Token resolution + the multi-process-safe OAuth refresh provider.
 *
 * Resolution order (first hit wins):
 *   1. explicit token (--token flag)
 *   2. VIDEODRAFT_API_KEY env
 *   3. the profile in the config store (PAT, or OAuth with auto-refresh)
 *
 * OAuth refresh tokens are SINGLE-USE (the server rotates them), and the CLI
 * shares its config store with other consumers (the macOS app's sidecar). So
 * refresh runs under a cross-process file lock and re-reads the store after
 * acquiring it — if another process already rotated, we use its fresh token
 * instead of redeeming a now-dead refresh token.
 */

import { AuthError } from "../core/errors.js";
import {
  DEFAULT_BASE_URL,
  getProfile,
  updateConfig,
  withLock,
  type Profile,
} from "../core/config.js";
import { refreshAccessToken } from "./oauth.js";
import type { TokenProvider } from "../core/rpc.js";

const EXPIRY_SKEW_MS = 60_000;

export interface ResolvedAuth {
  tokenProvider: TokenProvider;
  baseUrl: string;
  source: "flag" | "env" | "profile";
  profileName?: string;
}

function isExpiring(profile: Profile): boolean {
  if (!profile.expires_at) return false;
  return new Date(profile.expires_at).getTime() - Date.now() < EXPIRY_SKEW_MS;
}

function saveRotatedTokens(
  profileName: string,
  expected: { refreshToken: string; clientId: string },
  tokens: { access_token: string; refresh_token: string; expires_in: number },
  env: NodeJS.ProcessEnv,
): void {
  updateConfig((config) => {
    const profile = config.profiles[profileName];
    if (!profile) return;
    // A concurrent `login --profile <same>` may have stored a newer grant
    // while this refresh was in flight. updateConfig re-reads under the lock,
    // so only apply the rotation if the profile is STILL the OAuth grant we
    // refreshed — otherwise we'd clobber newer credentials (and could pair
    // auth_kind:"pat" with OAuth refresh fields).
    if (
      profile.auth_kind !== "oauth" ||
      profile.refresh_token !== expected.refreshToken ||
      profile.client_id !== expected.clientId
    ) {
      return;
    }
    profile.access_token = tokens.access_token;
    profile.refresh_token = tokens.refresh_token;
    profile.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  }, env);
}

/**
 * Refresh under lock. Returns the valid access token to use (possibly minted
 * by a concurrent process) or null when the grant is dead (→ re-login).
 */
async function refreshUnderLock(
  profileName: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return withLock(
    "oauth-refresh",
    async () => {
      // Re-read after acquiring: another process may have rotated already.
      const { profile } = getProfile(profileName, env);
      if (!profile) return null;
      if (profile.auth_kind !== "oauth") return profile.access_token;
      if (!isExpiring(profile)) return profile.access_token;
      if (!profile.refresh_token || !profile.client_id) return null;

      const expected = { refreshToken: profile.refresh_token, clientId: profile.client_id };
      const tokens = await refreshAccessToken({
        baseUrl: profile.base_url || DEFAULT_BASE_URL,
        clientId: expected.clientId,
        refreshToken: expected.refreshToken,
      });
      if (!tokens) return null;
      saveRotatedTokens(profileName, expected, tokens, env);
      // Return whatever is now stored: our rotation, or a newer grant a
      // concurrent login wrote (in which case saveRotatedTokens skipped).
      const { profile: latest } = getProfile(profileName, env);
      return latest?.access_token ?? tokens.access_token;
    },
    env,
  );
}

export function profileTokenProvider(
  profileName: string,
  env: NodeJS.ProcessEnv = process.env,
): TokenProvider {
  return {
    async getAccessToken() {
      const { profile } = getProfile(profileName, env);
      if (!profile?.access_token) throw new AuthError();
      if (profile.auth_kind === "oauth" && isExpiring(profile)) {
        const fresh = await refreshUnderLock(profileName, env);
        if (!fresh) throw new AuthError("Your session expired and could not be refreshed.");
        return fresh;
      }
      return profile.access_token;
    },
    async onUnauthorized() {
      const { profile } = getProfile(profileName, env);
      if (profile?.auth_kind !== "oauth") return null;
      // Force-expire then refresh under lock.
      updateConfig((config) => {
        const p = config.profiles[profileName];
        if (p) p.expires_at = new Date(0).toISOString();
      }, env);
      return refreshUnderLock(profileName, env);
    },
  };
}

export function resolveAuth(options: {
  token?: string;
  baseUrl?: string;
  profile?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedAuth {
  const env = options.env ?? process.env;
  const envBase = env.VIDEODRAFT_BASE_URL;

  if (options.token) {
    return {
      tokenProvider: { getAccessToken: async () => options.token! },
      baseUrl: options.baseUrl ?? envBase ?? DEFAULT_BASE_URL,
      source: "flag",
    };
  }
  if (env.VIDEODRAFT_API_KEY) {
    return {
      tokenProvider: { getAccessToken: async () => env.VIDEODRAFT_API_KEY! },
      baseUrl: options.baseUrl ?? envBase ?? DEFAULT_BASE_URL,
      source: "env",
    };
  }
  const { name, profile } = getProfile(options.profile, env);
  return {
    tokenProvider: profileTokenProvider(name, env),
    baseUrl: options.baseUrl ?? envBase ?? profile?.base_url ?? DEFAULT_BASE_URL,
    source: "profile",
    profileName: name,
  };
}
