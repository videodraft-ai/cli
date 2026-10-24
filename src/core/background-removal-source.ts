import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { configDir } from "./config.js";
import { UsageError } from "./errors.js";

/** Keep a local file's uploaded URL stable across retries of one paid operation. */
export async function prepareBackgroundRemovalSource(
  scope: string,
  operationId: string,
  source: string,
  upload: () => Promise<string>,
  root = path.join(configDir(), "background-removal-requests"),
): Promise<string> {
  if (/^https?:\/\//i.test(source)) return source;
  if (!/^[0-9a-f-]{36}$/i.test(operationId))
    throw new UsageError("Invalid operation UUID.");
  const absolute = path.resolve(source),
    stat = fs.statSync(absolute);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        path: absolute,
        bytes: stat.size,
        modified: stat.mtimeMs,
      }),
    )
    .digest("hex");
  const directory = path.join(
    root,
    createHash("sha256").update(scope).digest("hex").slice(0, 24),
  );
  const filename = path.join(directory, `${operationId.toLowerCase()}.json`);
  const read = (): string | undefined => {
    let content: string;
    try {
      content = fs.readFileSync(filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const saved = JSON.parse(content);
    if (saved.fingerprint !== fingerprint)
      throw new UsageError(
        "This idempotency key was used with a different source file. Use the original file to retry, or a new key for a new operation.",
      );
    if (typeof saved.url !== "string" || !/^https?:\/\//i.test(saved.url))
      throw new Error(
        "Saved background removal source is invalid. Check the original job before retrying.",
      );
    return saved.url;
  };
  const existing = read();
  if (existing) return existing;
  const url = await upload();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ fingerprint, url }), {
    mode: 0o600,
  });
  try {
    fs.linkSync(temporary, filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return read()!;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return url;
}
