import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { authorizeViaLoopback, buildAuthorizeUrl, createPkcePair } from "../src/auth/oauth.js";

describe("PKCE", () => {
  it("produces an S256 challenge of the verifier", () => {
    const { verifier, challenge } = createPkcePair();
    const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });
});

describe("buildAuthorizeUrl", () => {
  it("carries every required OAuth param", () => {
    const url = new URL(
      buildAuthorizeUrl({
        baseUrl: "https://app.test",
        clientId: "vd_client_cli",
        redirectUri: "http://127.0.0.1:9999/callback",
        state: "st",
        codeChallenge: "ch",
      }),
    );
    expect(url.pathname).toBe("/api/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("vd_client_cli");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9999/callback");
    expect(url.searchParams.get("scope")).toBe("mcp");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://app.test/api/mcp");
  });
});

describe("authorizeViaLoopback", () => {
  it("resolves with the code delivered to the loopback listener", async () => {
    const result = await authorizeViaLoopback({
      baseUrl: "https://app.test",
      clientId: "vd_client_cli",
      onAuthorizeUrl: async (authorizeUrl) => {
        const url = new URL(authorizeUrl);
        const redirect = new URL(url.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", "vd_ac_test123");
        redirect.searchParams.set("state", url.searchParams.get("state")!);
        await fetch(redirect); // simulate the browser hitting the callback
      },
    });
    expect(result.code).toBe("vd_ac_test123");
    expect(result.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("rejects on a state mismatch", async () => {
    await expect(
      authorizeViaLoopback({
        baseUrl: "https://app.test",
        clientId: "vd_client_cli",
        onAuthorizeUrl: async (authorizeUrl) => {
          const url = new URL(authorizeUrl);
          const redirect = new URL(url.searchParams.get("redirect_uri")!);
          redirect.searchParams.set("code", "vd_ac_test123");
          redirect.searchParams.set("state", "WRONG");
          await fetch(redirect).catch(() => {});
        },
      }),
    ).rejects.toThrow(/state/i);
  });

  it("rejects when the provider returns an error", async () => {
    await expect(
      authorizeViaLoopback({
        baseUrl: "https://app.test",
        clientId: "vd_client_cli",
        onAuthorizeUrl: async (authorizeUrl) => {
          const url = new URL(authorizeUrl);
          const redirect = new URL(url.searchParams.get("redirect_uri")!);
          redirect.searchParams.set("error", "access_denied");
          await fetch(redirect).catch(() => {});
        },
      }),
    ).rejects.toThrow(/access_denied/);
  });
});
