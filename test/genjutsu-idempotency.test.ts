import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({ callTool: vi.fn(), uploadFile: vi.fn() }));
vi.mock("../src/cli/context.js", async () => ({
  ...(await vi.importActual<typeof import("../src/cli/context.js")>(
    "../src/cli/context.js",
  )),
  buildContext: () => ({
    client: { callTool: mocks.callTool },
    out: { json: true, color: false, isTTY: false },
    flags: { token: "test-account" },
    baseUrl: "https://example.test",
  }),
}));
vi.mock("../src/core/upload.js", async () => ({
  ...(await vi.importActual<typeof import("../src/core/upload.js")>(
    "../src/core/upload.js",
  )),
  uploadFile: mocks.uploadFile,
}));
import { registerEditCommands } from "../src/commands/edit.js";

const id = "11111111-1111-4111-8111-111111111111";
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genjutsu-retry-"));
  vi.stubEnv("VIDEODRAFT_CONFIG_DIR", path.join(root, "config"));
  mocks.callTool.mockReset();
  mocks.uploadFile.mockReset();
  mocks.uploadFile.mockImplementation(async (_client, file) => ({
    url: `https://cdn.example/${mocks.uploadFile.mock.calls.length}/${path.basename(file)}`,
  }));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
const run = async (args: string[]) => {
  const program = new Command();
  registerEditCommands(program);
  await program.parseAsync(args, { from: "user" });
};

it("retries local motion media with identical uploaded URLs after a lost receipt", async () => {
  const image = path.join(root, "subject.png");
  const reference = path.join(root, "reference.png");
  const video = path.join(root, "source.mp4");
  for (const file of [image, reference, video])
    fs.writeFileSync(file, "original media");
  const args = [
    "edit",
    "motion",
    image,
    "--ref",
    reference,
    "--motion-video",
    video,
    "--model",
    "genjutsu-light",
    "--idempotency-key",
    id,
    "--no-wait",
  ];
  mocks.callTool
    .mockRejectedValueOnce(new Error("receipt lost"))
    .mockResolvedValue({ job_id: id, status: "pending" });
  await expect(run(args)).rejects.toThrow("receipt lost");
  await run(args);
  expect(mocks.callTool.mock.calls[1]).toEqual(mocks.callTool.mock.calls[0]);
  expect(mocks.uploadFile).toHaveBeenCalledTimes(3);
  fs.writeFileSync(video, "different media bytes");
  await expect(run(args)).rejects.toThrow(/different source file/);
  expect(mocks.callTool).toHaveBeenCalledTimes(2);
});
