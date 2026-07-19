import { describe, expect, it, vi } from "vitest";
import { callAudioWithRetry } from "../src/core/audio-retry.js";
import { RpcError, ToolError } from "../src/core/errors.js";

describe("callAudioWithRetry", () => {
  it("reuses the same call after a lost response and in-progress replay", async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network lost"))
      .mockRejectedValueOnce(
        new ToolError(
          "generate_audio",
          "audio operation is already in progress",
        ),
      )
      .mockResolvedValueOnce({ success: true });

    await expect(
      callAudioWithRetry(call, { attempts: 3, wait: async () => {} }),
    ).resolves.toEqual({ success: true });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("does not retry terminal provider errors", async () => {
    const error = new ToolError("generate_audio", "provider rejected input");
    const call = vi.fn().mockRejectedValue(error);

    await expect(
      callAudioWithRetry(call, { wait: async () => {} }),
    ).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("retries gateway responses and structured recovery errors", async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new RpcError(504, "gateway timeout"))
      .mockRejectedValueOnce(
        new ToolError(
          "generate_audio",
          "/api/seed-audio failed [RECOVERY_PENDING]: fetch failed",
        ),
      )
      .mockResolvedValueOnce({ success: true });

    await expect(
      callAudioWithRetry(call, { attempts: 3, wait: async () => {} }),
    ).resolves.toEqual({ success: true });
    expect(call).toHaveBeenCalledTimes(3);
  });
});
