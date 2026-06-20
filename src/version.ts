import fs from "node:fs";

/**
 * Resolve the package version at runtime. package.json sits one level above
 * both src/ (tsx dev) and dist/ (built bundle), so ../package.json works in
 * either mode.
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION: string = readVersion();
