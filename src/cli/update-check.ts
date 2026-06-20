/**
 * Once-a-day npm update notice. Human TTY mode only; silent everywhere an
 * agent or script could be parsing output. Never throws, never blocks.
 */

import { readConfig, updateConfig } from "../core/config.js";
import { VERSION } from "../version.js";

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export async function maybeCheckForUpdate(): Promise<void> {
  try {
    if (!process.stderr.isTTY) return;
    if (process.env.CI || process.env.DO_NOT_TRACK) return;
    if (process.env.VIDEODRAFT_NO_UPDATE_CHECK) return;

    const config = readConfig();
    if (config.last_update_check && Date.now() - config.last_update_check < CHECK_EVERY_MS) return;
    updateConfig((c) => {
      c.last_update_check = Date.now();
    });

    const res = await fetch("https://registry.npmjs.org/videodraft/latest", {
      signal: AbortSignal.timeout(1_500),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return;
    const body: any = await res.json();
    const latest = body?.version;
    if (typeof latest === "string" && isNewer(latest, VERSION)) {
      process.stderr.write(
        `\nA new version of videodraft is available: ${VERSION} → ${latest}\n` +
          `  npm install -g videodraft\n\n`,
      );
    }
  } catch {
    // never interfere with the actual command
  }
}
