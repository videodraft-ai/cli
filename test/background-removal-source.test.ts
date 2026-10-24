import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareBackgroundRemovalSource } from "../src/core/background-removal-source.js";

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);
const ID = "11111111-1111-4111-8111-111111111111";
it("retries a local file with the original uploaded URL and rejects changed inputs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "background-removal-"));
  directories.push(root);
  const file = path.join(root, "source.png");
  fs.writeFileSync(file, "source");
  let uploads = 0;
  const upload = async () => `https://cdn.example/upload-${++uploads}.png`;
  const first = await prepareBackgroundRemovalSource(
    "account",
    ID,
    file,
    upload,
    root,
  );
  expect(
    await prepareBackgroundRemovalSource(
      "account",
      ID.toUpperCase(),
      file,
      upload,
      root,
    ),
  ).toBe(first);
  expect(uploads).toBe(1);
  fs.writeFileSync(file, "different source");
  await expect(
    prepareBackgroundRemovalSource("account", ID, file, upload, root),
  ).rejects.toThrow(/different source/);
  expect(uploads).toBe(1);
});
it("concurrent uploads converge to one URL and account scopes stay separate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "background-removal-"));
  directories.push(root);
  const file = path.join(root, "source.png");
  fs.writeFileSync(file, "source");
  let uploads = 0;
  const upload = async () => `https://cdn.example/upload-${++uploads}.png`;
  const urls = await Promise.all([
    prepareBackgroundRemovalSource("a", ID, file, upload, root),
    prepareBackgroundRemovalSource("a", ID, file, upload, root),
  ]);
  expect(urls[0]).toBe(urls[1]);
  expect(
    await prepareBackgroundRemovalSource("b", ID, file, upload, root),
  ).not.toBe(urls[0]);
});
