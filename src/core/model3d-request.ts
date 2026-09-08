/** Reuse uploaded references when retrying a 3D request with the same UUID. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { configDir } from "./config.js";
import { CliError, EXIT } from "./errors.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FIELDS = new Set([
  "request_id",
  "project_id",
  "asset_id",
  "source_asset_id",
]);

export function normalize3DUuid(value: string | undefined): string | undefined {
  return typeof value === "string" && UUID_RE.test(value)
    ? value.toLowerCase()
    : value;
}

/** Normalize top-level identity fields only; URLs, local paths and Fal options are opaque. */
function normalizeIdentityUuids(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      UUID_FIELDS.has(key) && typeof item === "string"
        ? normalize3DUuid(item)
        : item,
    ]),
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

export function localReferenceIdentity(source: string): unknown {
  if (/^https?:\/\//i.test(source)) return source;
  const absolute = path.resolve(source);
  const stat = fs.statSync(absolute);
  return { path: absolute, bytes: stat.size, modified_ms: stat.mtimeMs };
}

export async function prepare3DRequest(
  scope: string,
  requestId: string,
  identity: unknown,
  resolve: () => Promise<Record<string, unknown>>,
  root = path.join(configDir(), "3d-requests"),
): Promise<{ args: Record<string, unknown>; reused: boolean }> {
  if (!UUID_RE.test(requestId))
    throw new CliError("Invalid 3D request UUID.", EXIT.USAGE);
  requestId = requestId.toLowerCase();
  const directory = path.join(
    root,
    createHash("sha256").update(scope).digest("hex").slice(0, 24),
  );
  const journalPath = path.join(directory, `${requestId}.json`);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(canonical(normalizeIdentityUuids(identity))) ?? "null",
    )
    .digest("hex");
  const read = (): Record<string, unknown> | undefined => {
    let content: string;
    try {
      content = fs.readFileSync(journalPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let saved: any;
    try {
      saved = JSON.parse(content);
    } catch {
      throw new CliError(
        `The saved request journal is unreadable: ${journalPath}. Use status/wait with the original job id before submitting again.`,
      );
    }
    if (saved.fingerprint !== fingerprint)
      throw new CliError(
        `Request ${requestId} was already used with different inputs. Use the original inputs to retry, or omit --request-id for a new generation.`,
        EXIT.USAGE,
      );
    if (
      !saved.args ||
      typeof saved.args !== "object" ||
      normalize3DUuid(saved.args.request_id) !== requestId
    )
      throw new CliError(`Invalid saved 3D request: ${journalPath}`);
    return normalizeIdentityUuids(saved.args) as Record<string, unknown>;
  };
  const existing = read();
  if (existing) return { args: existing, reused: true };
  const args = normalizeIdentityUuids(await resolve()) as Record<
    string,
    unknown
  >;
  if (args.request_id !== requestId)
    throw new CliError(
      "Resolved 3D request does not match its request UUID.",
      EXIT.USAGE,
    );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Publish without overwriting an existing request, including another CLI process.
  const temporary = `${journalPath}.${randomUUID()}.tmp`;
  fs.writeFileSync(
    temporary,
    JSON.stringify({ version: 1, fingerprint, args }, null, 2) + "\n",
    { mode: 0o600 },
  );
  try {
    fs.linkSync(temporary, journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrent = read();
    if (!concurrent) throw error;
    return { args: concurrent, reused: true };
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { args, reused: false };
}
