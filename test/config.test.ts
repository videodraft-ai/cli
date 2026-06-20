import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configDir,
  configPath,
  readConfig,
  updateConfig,
  withLock,
  writeConfig,
} from "../src/core/config.js";
import { resolveAuth } from "../src/auth/token-provider.js";

let tmpDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-cli-test-"));
  env = { ...process.env, VIDEODRAFT_CONFIG_DIR: tmpDir };
  delete env.VIDEODRAFT_API_KEY;
  delete env.VIDEODRAFT_BASE_URL;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("config store", () => {
  it("honors VIDEODRAFT_CONFIG_DIR and round-trips profiles", () => {
    expect(configDir(env)).toBe(tmpDir);
    writeConfig(
      {
        version: 1,
        active_profile: "default",
        profiles: {
          default: { base_url: "https://x.test", auth_kind: "pat", access_token: "vd_mcp_abc" },
        },
      },
      env,
    );
    const loaded = readConfig(env);
    expect(loaded.profiles.default!.access_token).toBe("vd_mcp_abc");
  });

  it("falls back to XDG_CONFIG_HOME/videodraft", () => {
    const xdgEnv = { XDG_CONFIG_HOME: "/tmp/xdg-home" } as NodeJS.ProcessEnv;
    expect(configDir(xdgEnv)).toBe(path.join("/tmp/xdg-home", "videodraft"));
  });

  // chmod 0600 is a POSIX-only protection. On Windows there are no Unix mode
  // bits (NTFS uses ACLs), so statSync reports 0o666 regardless — the config is
  // instead protected by the per-user home ACL. Skip the assertion there.
  it.skipIf(process.platform === "win32")(
    "writes the config file with 0600 permissions",
    () => {
      writeConfig({ version: 1, active_profile: "default", profiles: {} }, env);
      const mode = fs.statSync(configPath(env)).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  it("returns an empty config for a missing or corrupt file", () => {
    expect(readConfig(env).profiles).toEqual({});
    fs.writeFileSync(configPath(env), "not json");
    expect(readConfig(env).profiles).toEqual({});
  });

  it("updateConfig mutates atomically", () => {
    updateConfig((c) => {
      c.profiles.default = { base_url: "https://x", auth_kind: "pat", access_token: "t" };
    }, env);
    updateConfig((c) => {
      c.telemetry = false;
    }, env);
    const loaded = readConfig(env);
    expect(loaded.profiles.default!.access_token).toBe("t");
    expect(loaded.telemetry).toBe(false);
  });
});

describe("withLock", () => {
  it("serializes concurrent critical sections", async () => {
    const order: string[] = [];
    await Promise.all([
      withLock(
        "test",
        async () => {
          order.push("a-start");
          await new Promise((r) => setTimeout(r, 150));
          order.push("a-end");
        },
        env,
      ),
      (async () => {
        await new Promise((r) => setTimeout(r, 20)); // ensure A grabs the lock first
        await withLock(
          "test",
          async () => {
            order.push("b-start");
          },
          env,
        );
      })(),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("steals a stale lock", async () => {
    const lockPath = path.join(tmpDir, "test.lock");
    fs.writeFileSync(lockPath, "{}");
    const old = Date.now() / 1000 - 120;
    fs.utimesSync(lockPath, old, old);
    await withLock("test", async () => {}, env); // should not hang
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe("resolveAuth precedence", () => {
  it("prefers the explicit --token flag", async () => {
    const auth = resolveAuth({ token: "vd_mcp_flag", env: { ...env, VIDEODRAFT_API_KEY: "vd_mcp_env" } });
    expect(auth.source).toBe("flag");
    expect(await auth.tokenProvider.getAccessToken()).toBe("vd_mcp_flag");
  });

  it("falls back to VIDEODRAFT_API_KEY", async () => {
    const auth = resolveAuth({ env: { ...env, VIDEODRAFT_API_KEY: "vd_mcp_env" } });
    expect(auth.source).toBe("env");
    expect(await auth.tokenProvider.getAccessToken()).toBe("vd_mcp_env");
  });

  it("falls back to the stored profile and its base_url", async () => {
    writeConfig(
      {
        version: 1,
        active_profile: "default",
        profiles: {
          default: { base_url: "https://stored.test", auth_kind: "pat", access_token: "vd_mcp_stored" },
        },
      },
      env,
    );
    const auth = resolveAuth({ env });
    expect(auth.source).toBe("profile");
    expect(auth.baseUrl).toBe("https://stored.test");
    expect(await auth.tokenProvider.getAccessToken()).toBe("vd_mcp_stored");
  });

  it("env base URL overrides the profile's", () => {
    writeConfig(
      {
        version: 1,
        active_profile: "default",
        profiles: {
          default: { base_url: "https://stored.test", auth_kind: "pat", access_token: "t" },
        },
      },
      env,
    );
    const auth = resolveAuth({ env: { ...env, VIDEODRAFT_BASE_URL: "https://override.test" } });
    expect(auth.baseUrl).toBe("https://override.test");
  });
});
