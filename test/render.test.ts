import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  // waitInterval makes the render poller use intervalMs (1 ms) below.
  flags: { json: true, waitInterval: "1ms" } as Record<string, unknown>,
  // Human output tests turn JSON off to read what a person sees.
  json: true,
}));

vi.mock("../src/cli/context.js", async () => {
  const actual = await vi.importActual<typeof import("../src/cli/context.js")>(
    "../src/cli/context.js",
  );
  return {
    ...actual,
    buildContext: () => ({
      client: { callTool: mocks.callTool },
      out: { json: mocks.json, color: false, isTTY: false },
      flags: mocks.flags,
      baseUrl: "https://example.test",
      intervalMs: 1,
      timeoutMs: 600_000,
      adaptive: true,
    }),
  };
});

import {
  RESUMABLE_CHUNK_ALIGNMENT,
  fileSha256,
  nextOffsetFromRange,
  uploadResumable,
} from "../src/core/resumable-upload.js";
import { pollRenderJob } from "../src/core/poll.js";
import { EXIT, RpcError, ToolError } from "../src/core/errors.js";
import {
  billedText,
  costText,
  defaultJobName,
  jobNameOption,
  machinesSummary,
  parseFrameRange,
  registerRenderCommands,
  renderOutputPath,
  stateText,
  waitedText,
} from "../src/commands/render.js";

const CHUNK = RESUMABLE_CHUNK_ALIGNMENT;
const JOB = "job_0123456789abcdef";
const UPLOAD_URL = "https://storage.test/upload/scene?upload_id=abc";
const CLIP_URL = "https://storage.test/users/u/jobs/job/clip.mp4?sig=1";
const noSleep = async () => {};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vd-render-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function writeFile(
  name: string,
  bytes: number,
): { file: string; data: Buffer } {
  const data = randomBytes(bytes);
  const file = path.join(tmp, name);
  fs.writeFileSync(file, data);
  return { file, data };
}

type Behaviour =
  | "ok"
  | "network" // fails before GCS stores anything
  | "lost-reply" // GCS stores the chunk, the reply never arrives
  | { store: number } // GCS stores only this many bytes of the chunk
  | { status: number };

/**
 * An in-memory GCS resumable session. Each PUT takes the next behaviour
 * (default "ok"); protocol violations are collected rather than thrown, since
 * a throw inside fetch would look like a network error to the uploader.
 */
function gcsSession(total: number, behaviours: Behaviour[] = []) {
  const stored = Buffer.alloc(total);
  let persisted = 0;
  const requests: string[] = [];
  const violations: string[] = [];
  const reply = () =>
    persisted === total
      ? new Response("{}", { status: 200 })
      : new Response("", {
          status: 308,
          headers: persisted > 0 ? { range: `bytes=0-${persisted - 1}` } : {},
        });
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const range = headers["content-range"] ?? "";
    // Copy now: the uploader may reuse nothing, but the test must not care.
    const body = init.body
      ? Buffer.from(init.body as Uint8Array)
      : Buffer.alloc(0);
    requests.push(range);
    if (init.method !== "PUT") violations.push(`method ${init.method}`);
    if (init.redirect !== "manual") violations.push("308 must not be followed");
    const behaviour = behaviours.shift() ?? "ok";
    if (behaviour === "network") throw new TypeError("fetch failed");
    if (typeof behaviour === "object" && "status" in behaviour) {
      return new Response("busy", { status: behaviour.status });
    }
    if (range === `bytes */${total}`) {
      if (body.length !== 0 || headers["content-length"] !== "0") {
        violations.push("a status query must have an empty body");
      }
      return reply();
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!match) {
      violations.push(`bad Content-Range: ${range}`);
      return new Response("", { status: 400 });
    }
    const first = Number(match[1]);
    const last = Number(match[2]);
    if (Number(match[3]) !== total) violations.push(`total ${match[3]}`);
    if (first !== persisted)
      violations.push(`chunk at ${first}, expected ${persisted}`);
    if (body.length !== last - first + 1)
      violations.push(`body ${body.length} != range`);
    if (headers["content-length"] !== String(body.length)) {
      violations.push("Content-Length must match the chunk");
    }
    if (last + 1 < total && body.length % CHUNK !== 0) {
      violations.push(`non-final chunk of ${body.length} bytes`);
    }
    const keep =
      typeof behaviour === "object" && "store" in behaviour
        ? behaviour.store
        : body.length;
    body.copy(stored, first, 0, keep);
    persisted = first + keep;
    if (behaviour === "lost-reply") throw new TypeError("socket hang up");
    return reply();
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    requests,
    violations,
    stored: () => stored.subarray(0, persisted),
  };
}

describe("uploadResumable (GCS resumable protocol)", () => {
  it("sends 256 KiB-aligned chunks with Content-Range and stops on 200", async () => {
    const { file, data } = writeFile("scene.blend", 3 * CHUNK + 1000);
    const session = gcsSession(data.length);
    const progress: number[] = [];
    await uploadResumable(UPLOAD_URL, file, {
      fetchImpl: session.fetchImpl,
      chunkBytes: CHUNK,
      sleep: noSleep,
      onProgress: (stored) => progress.push(stored),
    });
    const total = data.length;
    expect(session.requests).toEqual([
      `bytes 0-${CHUNK - 1}/${total}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${total}`,
      `bytes ${2 * CHUNK}-${3 * CHUNK - 1}/${total}`,
      `bytes ${3 * CHUNK}-${total - 1}/${total}`,
    ]);
    expect(session.violations).toEqual([]);
    expect(session.stored().equals(data)).toBe(true);
    expect(progress).toEqual([CHUNK, 2 * CHUNK, 3 * CHUNK, total]);
  });

  it("resumes after the last stored byte when GCS keeps only part of a chunk", async () => {
    const { file, data } = writeFile("scene.blend", 3 * CHUNK);
    const session = gcsSession(data.length, ["ok", { store: 1000 }]);
    await uploadResumable(UPLOAD_URL, file, {
      fetchImpl: session.fetchImpl,
      chunkBytes: CHUNK,
      sleep: noSleep,
    });
    // The 308 said bytes=0-(CHUNK+999): the next chunk starts right after.
    expect(session.requests[2]).toBe(
      `bytes ${CHUNK + 1000}-${2 * CHUNK + 999}/${data.length}`,
    );
    expect(session.violations).toEqual([]);
    expect(session.stored().equals(data)).toBe(true);
  });

  it("asks the session where it stands after a dropped reply, then carries on", async () => {
    const { file, data } = writeFile("scene.blend", 3 * CHUNK);
    const total = data.length;
    const session = gcsSession(total, ["ok", "lost-reply"]);
    const sleep = vi.fn(noSleep);
    await uploadResumable(UPLOAD_URL, file, {
      fetchImpl: session.fetchImpl,
      chunkBytes: CHUNK,
      sleep,
    });
    // The second chunk was stored though its reply was lost, so it is not resent.
    expect(session.requests).toEqual([
      `bytes 0-${CHUNK - 1}/${total}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${total}`,
      `bytes */${total}`,
      `bytes ${2 * CHUNK}-${total - 1}/${total}`,
    ]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(session.violations).toEqual([]);
    expect(session.stored().equals(data)).toBe(true);
  });

  it("resends from the start when a dropped connection left nothing stored", async () => {
    const { file, data } = writeFile("scene.blend", CHUNK + 10);
    const total = data.length;
    const session = gcsSession(total, ["network"]);
    await uploadResumable(UPLOAD_URL, file, {
      fetchImpl: session.fetchImpl,
      chunkBytes: CHUNK,
      sleep: noSleep,
    });
    expect(session.requests).toEqual([
      `bytes 0-${CHUNK - 1}/${total}`,
      `bytes */${total}`, // 308 without a Range header: nothing stored
      `bytes 0-${CHUNK - 1}/${total}`,
      `bytes ${CHUNK}-${total - 1}/${total}`,
    ]);
    expect(session.stored().equals(data)).toBe(true);
  });

  it("retries a 503 and finishes when the final chunk's reply is lost", async () => {
    const { file, data } = writeFile("scene.blend", CHUNK + 10);
    const total = data.length;
    const session = gcsSession(total, [
      { status: 503 },
      "ok",
      "ok",
      "lost-reply",
    ]);
    await uploadResumable(UPLOAD_URL, file, {
      fetchImpl: session.fetchImpl,
      chunkBytes: CHUNK,
      sleep: noSleep,
    });
    expect(session.requests).toEqual([
      `bytes 0-${CHUNK - 1}/${total}`, // 503
      `bytes */${total}`,
      `bytes 0-${CHUNK - 1}/${total}`,
      `bytes ${CHUNK}-${total - 1}/${total}`, // stored, reply lost
      `bytes */${total}`, // 200: complete, nothing resent
    ]);
    expect(session.stored().equals(data)).toBe(true);
  });

  it("does not retry an expired session", async () => {
    const { file } = writeFile("scene.blend", 100);
    const session = gcsSession(100, [{ status: 404 }]);
    await expect(
      uploadResumable(UPLOAD_URL, file, {
        fetchImpl: session.fetchImpl,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/upload session has expired/);
    expect(session.requests).toHaveLength(1);
  });

  it("gives up after repeated failures instead of looping", async () => {
    const { file } = writeFile("scene.blend", 100);
    const session = gcsSession(100, Array<Behaviour>(10).fill("network"));
    await expect(
      uploadResumable(UPLOAD_URL, file, {
        fetchImpl: session.fetchImpl,
        sleep: noSleep,
        maxAttempts: 4,
      }),
    ).rejects.toThrow(
      /Upload interrupted after 4 failed attempts \(fetch failed\)/,
    );
    expect(session.requests).toHaveLength(4);
  });

  it("refuses a chunk size GCS would reject", async () => {
    const { file } = writeFile("scene.blend", 100);
    await expect(
      uploadResumable(UPLOAD_URL, file, { chunkBytes: 1000 }),
    ).rejects.toThrow(/multiple of 262144 bytes/);
  });

  it("reads the Range header of a 308", () => {
    expect(nextOffsetFromRange(null)).toBe(0);
    expect(nextOffsetFromRange("bytes=0-99")).toBe(100);
    expect(() => nextOffsetFromRange("bytes=5-9")).toThrow(/unexpected Range/);
  });

  it("hashes a file with SHA-256", async () => {
    const { file, data } = writeFile("scene.blend", 5 * 1024 * 1024 + 3);
    expect(await fileSha256(file)).toBe(
      createHash("sha256").update(data).digest("hex"),
    );
  });
});

describe("pollRenderJob", () => {
  it("rides out a transient failure and stops on a terminal status", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ status: "queued" })
      .mockRejectedValueOnce(new RpcError(502, "bad gateway"))
      .mockRejectedValueOnce(
        new ToolError("cloud_render_status", "busy", { http_status: 503 }),
      )
      .mockResolvedValueOnce({ status: "running", segments_done: 1 })
      .mockResolvedValueOnce({ status: "done", clip_url: CLIP_URL });
    const ticks: string[] = [];
    const job = await pollRenderJob({ callTool } as any, JOB, {
      sleep: noSleep,
      onTick: (payload) => ticks.push(payload.status),
    });
    expect(job.status).toBe("done");
    expect(ticks).toEqual(["queued", "running", "done"]);
    expect(callTool).toHaveBeenCalledWith("cloud_render_status", {
      job_id: JOB,
    });
  });

  it("stops at once on a refusal that will not pass", async () => {
    const callTool = vi.fn().mockRejectedValue(
      new ToolError("cloud_render_status", "Job not found", {
        http_status: 404,
      }),
    );
    await expect(
      pollRenderJob({ callTool } as any, JOB, { sleep: noSleep }),
    ).rejects.toThrow("Job not found");
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("treats paused as the end of a wait", async () => {
    const callTool = vi.fn().mockResolvedValue({ status: "paused" });
    await expect(
      pollRenderJob({ callTool } as any, JOB, { sleep: noSleep }),
    ).resolves.toMatchObject({ status: "paused" });
  });
});

describe("render helpers", () => {
  it("parses frame ranges", () => {
    expect(parseFrameRange("1-240")).toEqual({ start: 1, end: 240 });
    expect(parseFrameRange(" 0 - 0 ")).toEqual({ start: 0, end: 0 });
    expect(parseFrameRange("42")).toEqual({ start: 42, end: 42 });
    expect(() => parseFrameRange("240-1")).toThrow(/before the first/);
    expect(() => parseFrameRange("1:240")).toThrow(/frame range like 1-240/);
    expect(() => parseFrameRange("-5-10")).toThrow(/frame range like 1-240/);
  });

  it("says a cost is so far until it is final", () => {
    expect(
      costText({
        cost: {
          credits: 2.8,
          estimated_total_credits: 13.9,
          estimated_minutes_left: 1.9,
        },
      }),
    ).toBe("2.8 credits so far, about 13.9 in total, 1.9 min left");
    expect(costText({ cost: { credits: 12.1, final: true } })).toBe(
      "12.1 credits",
    );
    expect(costText({ cost: { credits: 9.4, final: false } })).toBe(
      "9.4 credits so far",
    );
    expect(costText({})).toBeUndefined();
  });

  it("words a job's state, waits and billed time plainly", () => {
    expect(stateText({ status: "queued", machine: { phase: "waiting" } })).toBe(
      "waiting for a free GPU (not billed)",
    );
    expect(stateText({ status: "queued" })).toBe("queued");
    expect(
      stateText({ status: "queued", machine: { phase: "starting" } }),
    ).toBe("GPU found, starting up");
    expect(
      stateText({ status: "running", segments_done: 1, segments_total: 4 }),
    ).toBe("rendering (1/4 segments)");
    expect(
      costText({
        status: "queued",
        machine: { phase: "waiting" },
        cost: { credits: 0, gpu_seconds: 0 },
      }),
    ).toBe("nothing yet (waiting for a GPU is not billed)");
    expect(
      costText({
        status: "queued",
        machine: { phase: "starting" },
        cost: { credits: 0 },
      }),
    ).toBe("0 credits so far");
    expect(
      costText({
        status: "done",
        cost: { credits: 8.6, estimated_total_credits: 9.4 },
      }),
    ).toBe("8.6 credits so far, about 9.4 once its machine switches off");
    // A hand-off leaves about a second of idle time; it is not worth a word.
    expect(
      billedText({
        cost: {
          gpu_seconds: 326,
          start_up_seconds: 0,
          render_seconds: 325,
          idle_seconds: 1,
        },
      }),
    ).toBe("5m 26s of GPU time (rendering 5m 25s)");
    expect(billedText({ cost: { gpu_seconds: 0 } })).toBeUndefined();
    expect(waitedText({ wait_seconds: 757 })).toBe(
      "12m 37s for a GPU, not billed",
    );
    expect(machinesSummary([])).toBe("none");
    expect(
      machinesSummary([
        { phase: "waiting" },
        { phase: "rendering" },
        { phase: "waiting" },
      ]),
    ).toBe("3 machines: 1 rendering, 2 waiting for a GPU (not billed)");
    // Servers from before phases: their states.
    expect(machinesSummary([{ state: "running" }])).toBe(
      "1 machine: 1 running",
    );
  });

  it("names a job after its scene and frames, within 80 characters", () => {
    expect(
      defaultJobName("/x/main_v8_packed.blend", { start: 845, end: 1350 }),
    ).toBe("main_v8_packed 845-1350");
    expect(defaultJobName("/x/shot.BLEND", { start: 42, end: 42 })).toBe(
      "shot 42",
    );
    const long = defaultJobName(`/x/${"a".repeat(120)}.blend`, {
      start: 1,
      end: 240,
    });
    expect([...long].length).toBe(80);
    expect(long.endsWith(" 1-240")).toBe(true);
    expect(jobNameOption(" S4   final ")).toBe("S4 final");
  });

  it("names the clip after the job unless --out names a file", () => {
    expect(renderOutputPath(undefined, JOB, CLIP_URL)).toBe(
      path.join("media", "renders", `${JOB}.mp4`),
    );
    expect(renderOutputPath("out", JOB, CLIP_URL)).toBe(
      path.join("out", `${JOB}.mp4`),
    );
    expect(renderOutputPath("final.mp4", JOB, CLIP_URL)).toBe("final.mp4");
  });
});

describe("videodraft render", () => {
  let stdout: string[];
  beforeEach(() => {
    mocks.callTool.mockReset();
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  async function run(args: string[]): Promise<void> {
    const program = new Command();
    program.option("--json");
    program.exitOverride();
    registerRenderCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  const output = () => JSON.parse(stdout.join(""));

  /** Answer each tool from a table; status replies are consumed in order. */
  function tools(table: Record<string, unknown>, statuses: unknown[] = []) {
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === "cloud_render_status") {
        const next = statuses.shift();
        if (!next) throw new Error("polled after the job finished");
        return next;
      }
      if (!(name in table)) throw new Error(`unexpected tool ${name}`);
      const value = table[name];
      if (value instanceof Error) throw value;
      return value;
    });
  }

  /** Serves the clip download, and the upload session when one is given. */
  function network(session?: ReturnType<typeof gcsSession>) {
    const fake = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === CLIP_URL) return new Response("MP4DATA", { status: 200 });
      if (url === UPLOAD_URL && session) return session.fetchImpl(url, init);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fake);
    return fake;
  }

  const submitted = {
    job_id: JOB,
    status: "queued",
    machine: { state: "starting" },
    credits_per_minute: 3.76,
    segments: 2,
  };

  it("renders an uploaded scene: submit, wait, download", async () => {
    const { file, data } = writeFile("scene.blend", 2048);
    const sha = createHash("sha256").update(data).digest("hex");
    tools(
      {
        cloud_render_upload_scene: { exists: true },
        cloud_render_submit: submitted,
      },
      [
        { job_id: JOB, status: "running", segments_done: 0, segments_total: 2 },
        { job_id: JOB, status: "running", segments_done: 1, segments_total: 2 },
        {
          job_id: JOB,
          status: "done",
          segments_done: 2,
          segments_total: 2,
          clip_url: CLIP_URL,
        },
      ],
    );
    network();
    const out = path.join(tmp, "renders");
    await run([
      "render",
      "blender",
      file,
      "--frames",
      "1-48",
      "--fps",
      "24",
      "--blender",
      "4.5",
      "--out",
      out,
    ]);
    expect(mocks.callTool.mock.calls.map(([name]) => name)).toEqual([
      "cloud_render_upload_scene",
      "cloud_render_submit",
      "cloud_render_status",
      "cloud_render_status",
      "cloud_render_status",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith("cloud_render_upload_scene", {
      sha256: sha,
      size: 2048,
    });
    // Only the options that were passed reach the server.
    expect(mocks.callTool).toHaveBeenCalledWith("cloud_render_submit", {
      scene_sha: sha,
      start: 1,
      end: 48,
      fps: 24,
      blender_version: "4.5",
      // Without --name, the scene's file name and the frames.
      name: "scene 1-48",
    });
    const saved = path.join(out, `${JOB}.mp4`);
    expect(fs.readFileSync(saved, "utf8")).toBe("MP4DATA");
    const result = output();
    expect(result).toMatchObject({
      job_id: JOB,
      status: "done",
      scene_sha: sha,
      uploaded: false,
      downloaded_files: [{ path: saved, bytes: 7, url: CLIP_URL }],
    });
    // --json hides stderr hints, so the document itself says to stop the GPU.
    expect(result.next_step).toContain("videodraft render stop");
  });

  it("uploads a new scene with the resumable protocol, then finalizes it", async () => {
    const { file, data } = writeFile("scene.blend", 4096);
    const sha = createHash("sha256").update(data).digest("hex");
    tools(
      {
        cloud_render_upload_scene: { exists: false, upload_url: UPLOAD_URL },
        cloud_render_finalize_scene: { ok: true },
        cloud_render_submit: submitted,
      },
      [{ job_id: JOB, status: "done", clip_url: CLIP_URL }],
    );
    const session = gcsSession(data.length);
    network(session);
    await run(["render", "blender", file, "--frames", "1-2", "--out", tmp]);
    expect(session.requests).toEqual([`bytes 0-4095/4096`]);
    expect(session.stored().equals(data)).toBe(true);
    expect(mocks.callTool.mock.calls.map(([name]) => name)).toEqual([
      "cloud_render_upload_scene",
      "cloud_render_finalize_scene",
      "cloud_render_submit",
      "cloud_render_status",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith("cloud_render_finalize_scene", {
      sha256: sha,
    });
    expect(output()).toMatchObject({ uploaded: true, status: "done" });
  });

  it("--gpu picks the GPU size and refuses an unknown one", async () => {
    const { file } = writeFile("scene.blend", 10);
    tools({
      cloud_render_upload_scene: { exists: true },
      cloud_render_submit: { ...submitted, gpu: "quarter" },
    });
    await run([
      "render",
      "blender",
      file,
      "--frames",
      "5",
      "--gpu",
      "quarter",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "cloud_render_submit",
      expect.objectContaining({ gpu: "quarter" }),
    );
    await expect(
      run([
        "render",
        "blender",
        file,
        "--frames",
        "5",
        "--gpu",
        "l4",
        "--no-wait",
      ]),
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });

  it("--no-wait returns the job without polling", async () => {
    const { file } = writeFile("scene.blend", 10);
    tools({
      cloud_render_upload_scene: { exists: true },
      cloud_render_submit: submitted,
    });
    await run(["render", "blender", file, "--frames", "5", "--no-wait"]);
    expect(mocks.callTool).not.toHaveBeenCalledWith(
      "cloud_render_status",
      expect.anything(),
    );
    expect(mocks.callTool).toHaveBeenCalledWith(
      "cloud_render_submit",
      expect.objectContaining({ start: 5, end: 5 }),
    );
    expect(output()).toMatchObject({
      job_id: JOB,
      status: "queued",
      uploaded: false,
      next_step: expect.stringContaining(`videodraft render wait ${JOB}`),
    });
  });

  it("exits with the credits code when a render pauses for credits", async () => {
    const { file } = writeFile("scene.blend", 10);
    tools(
      {
        cloud_render_upload_scene: { exists: true },
        cloud_render_submit: submitted,
      },
      [{ job_id: JOB, status: "paused", segments_done: 1, segments_total: 2 }],
    );
    await expect(
      run(["render", "blender", file, "--frames", "1-2", "--out", tmp]),
    ).rejects.toMatchObject({
      exitCode: EXIT.CREDITS,
      hint: expect.stringContaining(`videodraft render resume ${JOB}`),
    });
  });

  it("does not call a daily-limit or stop pause a credits problem", async () => {
    const { file } = writeFile("scene.blend", 10);
    const daily =
      "Daily Cloud render limit reached (8 GPU-hours in 24 hours). Resume it later.";
    for (const paused of [
      { pause_reason: "daily_limit", error: daily },
      { error: daily },
      {
        pause_reason: "user",
        error: "The machine was stopped. Resume the job to continue.",
      },
    ]) {
      tools(
        {
          cloud_render_upload_scene: { exists: true },
          cloud_render_submit: submitted,
        },
        [
          {
            job_id: JOB,
            status: "paused",
            segments_done: 1,
            segments_total: 2,
            ...paused,
          },
        ],
      );
      await expect(
        run(["render", "blender", file, "--frames", "1-2", "--out", tmp]),
      ).rejects.toMatchObject({
        exitCode: EXIT.ERROR,
        message: expect.stringContaining(paused.error),
        hint: expect.stringContaining(`videodraft render resume ${JOB}`),
      });
    }
    tools(
      {
        cloud_render_upload_scene: { exists: true },
        cloud_render_submit: submitted,
      },
      [
        {
          job_id: JOB,
          status: "paused",
          pause_reason: "credits",
          error: "Out of credits. Add credits, then resume the job.",
        },
      ],
    );
    await expect(
      run(["render", "blender", file, "--frames", "1-2", "--out", tmp]),
    ).rejects.toMatchObject({ exitCode: EXIT.CREDITS });
  });

  it("maps a 402 from the GPU service to the credits exit code", async () => {
    const { file } = writeFile("scene.blend", 10);
    tools({
      cloud_render_upload_scene: { exists: true },
      cloud_render_submit: new ToolError(
        "cloud_render_submit",
        "A job needs at least 15 credits available to start.",
        { http_status: 402 },
      ),
    });
    await expect(
      run(["render", "blender", file, "--frames", "1-2"]),
    ).rejects.toMatchObject({ exitCode: EXIT.CREDITS });
    // The server's own wording is classified the same way.
    tools({
      cloud_render_upload_scene: { exists: true },
      cloud_render_submit: new ToolError(
        "cloud_render_submit",
        "Insufficient credits. A job needs at least 15 credits available to start.",
        { http_status: 402 },
      ),
    });
    await expect(
      run(["render", "blender", file, "--frames", "1-2"]),
    ).rejects.toMatchObject({ exitCode: EXIT.CREDITS });
  });

  it("a failed render exits 1 and suggests resume", async () => {
    const { file } = writeFile("scene.blend", 10);
    tools(
      {
        cloud_render_upload_scene: { exists: true },
        cloud_render_submit: submitted,
      },
      [{ job_id: JOB, status: "failed", error: "Blender crashed" }],
    );
    await expect(
      run(["render", "blender", file, "--frames", "1-2"]),
    ).rejects.toMatchObject({
      exitCode: EXIT.ERROR,
      message: expect.stringContaining("Blender crashed"),
    });
  });

  it.each([
    [["--frames", "10-1"], /before the first/],
    [["--frames", "1-2", "--blender", "3.6"], /--blender must be 5\.2 or 4\.5/],
    [
      ["--frames", "1-2", "--procs", "5"],
      /--procs must be a whole number from 1 to 4/,
    ],
    [["--frames", "1-2", "--fps", "0"], /--fps must be a whole number/],
  ])("rejects %j before any network call", async (flags, message) => {
    const { file } = writeFile("scene.blend", 10);
    await expect(run(["render", "blender", file, ...flags])).rejects.toThrow(
      message,
    );
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("needs an existing .blend file", async () => {
    const { file } = writeFile("scene.fbx", 10);
    await expect(
      run(["render", "blender", file, "--frames", "1"]),
    ).rejects.toThrow(/Expected a \.blend file/);
    await expect(
      run([
        "render",
        "blender",
        path.join(tmp, "missing.blend"),
        "--frames",
        "1",
      ]),
    ).rejects.toThrow(/Scene file not found/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it.each([
    [["render", "status", JOB], "cloud_render_status", { job_id: JOB }],
    [["render", "list", "--limit", "5"], "cloud_render_list", { limit: 5 }],
    [["render", "list"], "cloud_render_list", {}],
    [["render", "cancel", JOB], "cloud_render_cancel", { job_id: JOB }],
    [["render", "resume", JOB], "cloud_render_resume", { job_id: JOB }],
    [["render", "machine"], "cloud_render_machine", {}],
    [["render", "stop"], "cloud_render_stop", {}],
    [["render", "prices"], "cloud_render_prices", {}],
  ])("%j calls %s", async (args, tool, toolArgs) => {
    const reply = { status: "queued", jobs: [] };
    mocks.callTool.mockResolvedValue(reply);
    await run(args);
    expect(mocks.callTool).toHaveBeenCalledWith(tool, toolArgs);
    expect(output()).toEqual(reply);
  });

  it("--name labels the job; an older server that keeps no name is not misquoted", async () => {
    const { file } = writeFile("main_v8_packed.blend", 10);
    tools({
      cloud_render_upload_scene: { exists: true },
      cloud_render_submit: { ...submitted, name: "main_v8_packed 845-1350" },
    });
    await run(["render", "blender", file, "--frames", "845-1350", "--no-wait"]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "cloud_render_submit",
      expect.objectContaining({ name: "main_v8_packed 845-1350" }),
    );
    expect(output()).toMatchObject({
      name: "main_v8_packed 845-1350",
      next_step: expect.stringContaining("Waiting for a GPU is not billed"),
    });

    stdout.length = 0;
    tools({
      cloud_render_upload_scene: { exists: true },
      cloud_render_submit: submitted,
    });
    await run([
      "render",
      "blender",
      file,
      "--frames",
      "845-1350",
      "--name",
      "  S7  final ",
      "--no-wait",
    ]);
    expect(mocks.callTool).toHaveBeenCalledWith(
      "cloud_render_submit",
      expect.objectContaining({ name: "S7 final" }),
    );
    expect(output().name).toBeNull();
  });

  it("refuses a --name that is empty, too long or looks like a job id", async () => {
    const { file } = writeFile("scene.blend", 10);
    for (const name of ["   ", "x".repeat(81), JOB, JOB.toUpperCase()]) {
      await expect(
        run(["render", "blender", file, "--frames", "1", "--name", name]),
      ).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    }
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("status, wait, cancel and resume take a job's name: the newest job with it", async () => {
    const older = {
      job_id: "job_00000000000000aa",
      name: "S4 final",
      status: "done",
      created_at: "2026-11-13T16:00:00Z",
    };
    const newer = {
      job_id: JOB,
      name: "S4 final",
      status: "running",
      created_at: "2026-11-13T17:00:00Z",
    };
    const other = {
      job_id: "job_00000000000000bb",
      name: "other",
      status: "queued",
      created_at: "2026-11-13T18:00:00Z",
    };
    mocks.callTool.mockImplementation(async (tool: string, args: any) => {
      if (tool === "cloud_render_list") return { jobs: [older, newer, other] };
      if (tool === "cloud_render_status")
        return { job_id: args.job_id, status: "running" };
      if (tool === "cloud_render_cancel")
        return { job_id: args.job_id, status: "cancelled" };
      throw new Error(`unexpected tool ${tool}`);
    });
    await run(["render", "status", "s4  FINAL"]);
    expect(mocks.callTool).toHaveBeenCalledWith("cloud_render_list", {
      name: "s4 FINAL",
      limit: 100,
    });
    expect(mocks.callTool).toHaveBeenCalledWith("cloud_render_status", {
      job_id: JOB,
    });
    await run(["render", "cancel", "S4 final"]);
    expect(mocks.callTool).toHaveBeenCalledWith("cloud_render_cancel", {
      job_id: JOB,
    });
  });

  it("refuses to guess between two jobs of one name, and says when none has it", async () => {
    mocks.callTool.mockResolvedValue({
      jobs: [
        {
          job_id: "job_00000000000000aa",
          name: "S4",
          status: "queued",
          created_at: "2026-11-13T16:00:00Z",
        },
        {
          job_id: "job_00000000000000bb",
          name: "S4",
          status: "running",
          created_at: "2026-11-13T17:00:00Z",
        },
        // A server from before names returns jobs without them: never a match.
        {
          job_id: "job_00000000000000cc",
          status: "queued",
          created_at: "2026-11-13T18:00:00Z",
        },
      ],
    });
    await expect(run(["render", "cancel", "S4"])).rejects.toMatchObject({
      exitCode: EXIT.USAGE,
      message: expect.stringContaining("job_00000000000000aa"),
    });
    await expect(run(["render", "status", "nope"])).rejects.toThrow(
      /No render job is named "nope"/,
    );
    expect(mocks.callTool).not.toHaveBeenCalledWith(
      "cloud_render_cancel",
      expect.anything(),
    );
  });

  it("list --name asks the server and filters for older servers too", async () => {
    mocks.callTool.mockResolvedValue({
      jobs: [
        { job_id: JOB, name: "S4", status: "done" },
        { job_id: "job_00000000000000bb", name: "S5", status: "done" },
      ],
      machines: [],
    });
    await run(["render", "list", "--name", "s4"]);
    expect(mocks.callTool).toHaveBeenCalledWith("cloud_render_list", {
      name: "s4",
    });
    expect(output().jobs.map((j: any) => j.job_id)).toEqual([JOB]);
  });

  it("cancel reports what the job cost", async () => {
    mocks.callTool.mockImplementation(async (tool: string) =>
      tool === "cloud_render_cancel"
        ? { job_id: JOB, status: "cancelled" }
        : {
            job_id: JOB,
            status: "cancelled",
            wait_seconds: 95,
            cost: { credits: 0, gpu_seconds: 0, final: true },
          },
    );
    await run(["render", "cancel", JOB]);
    expect(output()).toMatchObject({
      status: "cancelled",
      wait_seconds: 95,
      cost: { credits: 0, final: true },
    });
  });

  describe("what a person sees", () => {
    let stderr: string[];
    beforeEach(() => {
      mocks.json = false;
      stderr = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
        stderr.push(String(chunk));
        return true;
      });
    });
    afterEach(() => {
      mocks.json = true;
    });

    it("render machine never shows a machine waiting for a GPU as billed", async () => {
      mocks.callTool.mockResolvedValue({
        state: "running",
        credits_per_minute: 3.76,
        billing_credits_per_minute: 3.76,
        machines: [
          {
            name: "vd-a",
            gpu: "full",
            state: "running",
            phase: "rendering",
            billing: true,
            zone: "us-south1-a",
            job_id: JOB,
            credits_per_minute: 3.76,
          },
          {
            name: "vd-b",
            gpu: "full",
            state: "starting",
            phase: "waiting",
            billing: false,
            zone: "us-central1-b",
            job_id: "job_00000000000000aa",
            credits_per_minute: 3.76,
          },
        ],
        billed_24h: { seconds: 441, credits: 27.64 },
        billed_all_time: { seconds: 4020, credits: 228.25 },
        balance: 12000,
      });
      await run(["render", "machine"]);
      const text = stdout.join("");
      expect(text).toContain(
        "2 machines: 1 rendering, 1 waiting for a GPU (not billed)",
      );
      expect(text).toMatch(/billing now\s+3\.76 credits per minute/);
      expect(text).toContain("27.64 credits for 7m 21s of GPU time");
      expect(text).toContain("228.25 credits for 1h 7m of GPU time");
      expect(text).toMatch(
        /vd-b\s+full\s+waiting for a GPU \(not billed\)\s+us-central1-b\s+not billed/,
      );
      // A waiting machine's last job is history, not what it does now.
      expect(text).not.toContain("job_00000000000000aa");
      expect(text).not.toContain("burning");
      expect(stderr.join("")).toContain("Waiting for a GPU is not billed");
    });

    it("render wait says the wait is free and where the billed time went", async () => {
      tools({}, [
        {
          job_id: JOB,
          name: "S4",
          status: "queued",
          wait_seconds: 30,
          machine: { phase: "waiting" },
          cost: { credits: 0 },
        },
        {
          job_id: JOB,
          name: "S4",
          status: "queued",
          wait_seconds: 420,
          machine: { phase: "waiting" },
          cost: { credits: 0 },
        },
        {
          job_id: JOB,
          name: "S4",
          status: "running",
          segments_done: 1,
          segments_total: 2,
          cost: { credits: 1.2 },
        },
        {
          job_id: JOB,
          name: "S4",
          status: "done",
          clip_url: CLIP_URL,
          wait_seconds: 431,
          cost: {
            credits: 8.6,
            gpu_seconds: 138,
            start_up_seconds: 15,
            render_seconds: 38,
            idle_seconds: 85,
            final: true,
          },
        },
      ]);
      network();
      await run(["render", "wait", JOB, "--out", path.join(tmp, "s4.mp4")]);
      const log = stderr.join("");
      expect(log).toContain(`${JOB} (S4): waiting for a free GPU (not billed)`);
      expect(log).toContain("still no free GPU after 7m 0s");
      expect(log).toContain(`${JOB} (S4): rendering (1/2 segments)`);
      expect(log).toContain(`${JOB} (S4): 8.6 credits.`);
      expect(log).toContain(
        "Billed 2m 18s of GPU time (start-up 15s, rendering 38s, idle before switch-off 1m 25s). Waited 7m 11s for a GPU, not billed.",
      );
    });

    it("does not say no GPU is available after one has been assigned", async () => {
      tools({}, [
        {
          job_id: JOB,
          status: "queued",
          wait_seconds: 420,
          machine: { phase: "starting" },
          cost: { credits: 0 },
        },
        { job_id: JOB, status: "done", clip_url: CLIP_URL },
      ]);
      network();
      await run(["render", "wait", JOB, "--out", path.join(tmp, "s4.mp4")]);
      expect(stderr.join("")).not.toContain("still no free GPU");
    });

    it("does not claim a cancelled job is free before the final bill is known", async () => {
      mocks.callTool.mockImplementation(async (tool: string) =>
        tool === "cloud_render_cancel"
          ? { job_id: JOB, status: "cancelled" }
          : {
              job_id: JOB,
              status: "cancelled",
              cost: { credits: 0, gpu_seconds: 0, final: false },
            },
      );
      await run(["render", "cancel", JOB]);
      expect(stderr.join("")).toContain("0 credits so far");
      expect(stderr.join("")).not.toContain("No credits were charged");
    });

    it("does not infer account charges from a zero final job cost", async () => {
      mocks.callTool.mockImplementation(async (tool: string) =>
        tool === "cloud_render_cancel"
          ? { job_id: JOB, status: "cancelled" }
          : {
              job_id: JOB,
              status: "cancelled",
              cost: { credits: 0, gpu_seconds: 0, final: true },
            },
      );
      await run(["render", "cancel", JOB]);
      expect(stderr.join("")).toContain("Job cost: 0 credits");
      expect(stderr.join("")).toContain(
        "Machine charges not assigned to a job",
      );
      expect(stderr.join("")).toContain("videodraft render stop");
      expect(stderr.join("")).not.toContain("it cost nothing");
    });
  });

  it("render wait downloads a finished job", async () => {
    tools({}, [{ job_id: JOB, status: "done", clip_url: CLIP_URL }]);
    network();
    const target = path.join(tmp, "final.mp4");
    await run(["render", "wait", JOB, "--out", target]);
    expect(fs.readFileSync(target, "utf8")).toBe("MP4DATA");
    expect(output().downloaded_files[0].path).toBe(target);
  });
});
