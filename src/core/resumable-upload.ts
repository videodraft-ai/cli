/**
 * Chunked, resumable upload to a Google Cloud Storage resumable session URL,
 * such as the upload_url `cloud_render_upload_scene` returns for a scene.
 *
 * The protocol (cloud.google.com/storage/docs/performing-resumable-uploads):
 *
 *   PUT <session>  Content-Range: bytes <first>-<last>/<total>   (a chunk)
 *   PUT <session>  Content-Range: bytes * /<total>, empty body   (a status query)
 *     308  incomplete. "Range: bytes=0-<n>" says the bytes stored so far;
 *          no Range header means nothing is stored yet.
 *     200/201  the whole object is stored.
 *
 * Every chunk except the last must be a multiple of 256 KiB. GCS may store
 * fewer bytes than a chunk carried, so the next chunk always starts after the
 * last STORED byte, never after the last byte sent. After a dropped connection
 * or a 5xx the client asks the session where it stands and carries on from
 * there instead of starting over.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { CliError } from "./errors.js";

/** GCS requires every chunk but the last to be a multiple of this. */
export const RESUMABLE_CHUNK_ALIGNMENT = 256 * 1024;
export const DEFAULT_RESUMABLE_CHUNK_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface ResumableUploadOptions {
  fetchImpl?: typeof fetch;
  /** Bytes per PUT; a positive multiple of RESUMABLE_CHUNK_ALIGNMENT. */
  chunkBytes?: number;
  /** Failed attempts in a row (errors or chunks GCS stored nothing of) before giving up. */
  maxAttempts?: number;
  requestTimeoutMs?: number;
  /** Bytes the session has confirmed, after every reply. */
  onProgress?: (storedBytes: number, totalBytes: number) => void;
  /** Backoff between failed attempts; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

type Outcome = { done: true } | { done: false; next: number };

/** A failure worth asking the session about and trying again. */
function retryable(message: string): Error {
  return Object.assign(new Error(message), { retryable: true });
}

function isRetryable(error: unknown): boolean {
  return (error as { retryable?: unknown } | null)?.retryable === true;
}

/** The first byte still missing after a 308, from its Range header. */
export function nextOffsetFromRange(range: string | null): number {
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range.trim());
  if (!match) {
    throw new CliError(
      `The upload server sent an unexpected Range header: ${range}`,
    );
  }
  return Number(match[1]) + 1;
}

function backoffMs(failures: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** (failures - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

async function interpret(res: Response): Promise<Outcome> {
  // Drain the body so the connection can be reused; GCS error bodies are short.
  const text = await res.text().catch(() => "");
  if (res.status === 200 || res.status === 201) return { done: true };
  if (res.status === 308) {
    return { done: false, next: nextOffsetFromRange(res.headers.get("range")) };
  }
  const detail = text.trim().slice(0, 200);
  if (RETRYABLE_STATUS.has(res.status)) {
    throw retryable(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  if (res.status === 404 || res.status === 410) {
    throw new CliError(
      "The upload session has expired.",
      undefined,
      "Run the same command again to start a new upload.",
    );
  }
  throw new CliError(
    `Upload failed (HTTP ${res.status})${detail ? `: ${detail}` : "."}`,
  );
}

/**
 * Upload `filePath` to a resumable session. Resolves once GCS reports the
 * whole object stored; throws a CliError when the session refuses it or
 * stops making progress.
 */
export async function uploadResumable(
  uploadUrl: string,
  filePath: string,
  options: ResumableUploadOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const chunkBytes = options.chunkBytes ?? DEFAULT_RESUMABLE_CHUNK_BYTES;
  if (
    !Number.isSafeInteger(chunkBytes) ||
    chunkBytes <= 0 ||
    chunkBytes % RESUMABLE_CHUNK_ALIGNMENT !== 0
  ) {
    throw new CliError(
      `Upload chunks must be a positive multiple of ${RESUMABLE_CHUNK_ALIGNMENT} bytes.`,
    );
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const total = fs.statSync(filePath).size;
  if (total <= 0) throw new CliError("Cannot upload an empty file.");

  const put = async (
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Outcome> => {
    let res: Response;
    try {
      res = await fetchImpl(uploadUrl, {
        method: "PUT",
        headers,
        ...(body ? { body } : {}),
        // A GCS 308 means "resume incomplete", not a redirect to follow.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw retryable(error instanceof Error ? error.message : String(error));
    }
    return interpret(res);
  };

  const handle = await fs.promises.open(filePath, "r");
  try {
    let offset = 0;
    let failures = 0;
    let lastError = "";
    let askSession = false;
    for (;;) {
      let outcome: Outcome;
      let sent = false;
      try {
        if (askSession) {
          outcome = await put({
            "content-length": "0",
            "content-range": `bytes */${total}`,
          });
        } else {
          const length = Math.min(chunkBytes, total - offset);
          // A fresh buffer per attempt: a request that failed early may still
          // hold the previous one.
          const chunk = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(chunk, 0, length, offset);
          if (bytesRead !== length) {
            throw new CliError(
              `${filePath} changed while it was uploading. Run the command again.`,
            );
          }
          sent = true;
          outcome = await put(
            {
              "content-length": String(length),
              "content-range": `bytes ${offset}-${offset + length - 1}/${total}`,
            },
            chunk,
          );
        }
      } catch (error) {
        if (!isRetryable(error)) throw error;
        lastError = (error as Error).message;
        failures++;
        if (failures >= maxAttempts) break;
        askSession = true;
        await sleep(backoffMs(failures));
        continue;
      }
      askSession = false;
      if (outcome.done) {
        options.onProgress?.(total, total);
        return;
      }
      if (outcome.next > total) {
        throw new CliError(
          `The upload server reports ${outcome.next} bytes stored, more than the file's ${total}.`,
        );
      }
      if (outcome.next > offset) {
        failures = 0;
      } else if (sent) {
        // GCS kept none of the chunk. Count it, so a session that never moves
        // cannot loop forever.
        lastError = `no bytes stored at offset ${offset}`;
        failures++;
        if (failures >= maxAttempts) break;
        await sleep(backoffMs(failures));
      }
      offset = outcome.next;
      options.onProgress?.(offset, total);
    }
    throw new CliError(
      `Upload interrupted after ${failures} failed attempts (${lastError}).`,
      undefined,
      "Check your connection and run the same command again.",
    );
  } finally {
    await handle.close();
  }
}

/** SHA-256 of a file as lowercase hex, streamed so large scenes stay out of memory. */
export async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath, {
    highWaterMark: 4 * 1024 * 1024,
  })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
