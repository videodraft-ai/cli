import { RpcError, ToolError } from "./errors.js";

const RETRYABLE_AUDIO_ERROR =
  /already in progress|still being reconciled|settlement is still pending|recovery_pending/i;

export interface AudioRetryOptions {
  attempts?: number;
  delayMs?: number;
  wait?: (ms: number) => Promise<void>;
}

export function isRetryableAudioError(error: unknown): boolean {
  if (error instanceof ToolError) {
    return RETRYABLE_AUDIO_ERROR.test(error.message);
  }
  if (error instanceof RpcError) {
    return [0, 408, 502, 503, 504].includes(error.code);
  }
  if (error instanceof TypeError) return true;
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export async function callAudioWithRetry<T>(
  call: () => Promise<T>,
  options: AudioRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 45;
  const delayMs = options.delayMs ?? 1_500;
  const wait =
    options.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts || !isRetryableAudioError(error)) throw error;
      await wait(delayMs);
    }
  }

  throw new Error("Audio retry loop ended unexpectedly");
}
