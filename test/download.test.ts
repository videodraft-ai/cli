import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { beforeEach } from "vitest";
import {
  extFromUrl,
  previewPathFor,
  renderTemplate,
  resetPreviewCdnBreakerForTests,
  savedLine,
  shouldWritePreview,
  writePreview,
} from "../src/core/download.js";

describe("extFromUrl", () => {
  it("reads the extension from the URL path", () => {
    expect(extFromUrl("https://cdn.test/u/img/abc.png")).toBe("png");
    expect(extFromUrl("https://cdn.test/u/vid/abc.mp4?token=x")).toBe("mp4");
  });
  it("falls back when there is no extension", () => {
    expect(extFromUrl("https://cdn.test/u/abc")).toBe("bin");
    expect(extFromUrl("not a url", "png")).toBe("png");
  });
});

describe("renderTemplate", () => {
  it("substitutes placeholders", () => {
    expect(renderTemplate("./out/{job_id}_{index}.{ext}", { job_id: "j1", index: 2, ext: "png" })).toBe(
      "./out/j1_2.png",
    );
    expect(renderTemplate("{name}.{ext}", { name: "music", index: 0, ext: "mp3" })).toBe("music.mp3");
  });

  it("treats a no-placeholder, no-extension value as a directory", () => {
    // renderTemplate uses path.join here, so the separator is OS-specific —
    // compare with path.join, not a hard-coded POSIX slash (CI runs Windows).
    expect(renderTemplate("./outputs", { job_id: "j1", index: 0, ext: "png" })).toBe(
      path.join("outputs", "j1_0.png"),
    );
  });

  it("suffixes the index on concrete filenames for multi-output jobs", () => {
    expect(renderTemplate("final.mp4", { job_id: "j", index: 0, ext: "mp4" })).toBe("final.mp4");
    expect(renderTemplate("final.mp4", { job_id: "j", index: 1, ext: "mp4" })).toBe("final_1.mp4");
  });
});

describe("previews", () => {
  beforeEach(() => resetPreviewCdnBreakerForTests());

  it("targets a previews/ sibling, keeping the original extension so same-basename originals cannot collide", () => {
    expect(previewPathFor(path.join("media", "shot.png"))).toBe(
      path.join("media", "previews", "shot.png.jpg"),
    );
    expect(previewPathFor(path.join("media", "shot.png"), "webp")).toBe(
      path.join("media", "previews", "shot.png.webp"),
    );
    // The collision the flat scheme had: job.png and job.jpg previews differ.
    expect(previewPathFor(path.join("media", "job.png"))).not.toBe(
      previewPathFor(path.join("media", "job.jpg")),
    );
  });

  it("invalidates stale previews when the replacement no longer qualifies", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vd-preview-test-"));
    try {
      const original = path.join(tmpRoot, "shot.png");
      const previews = path.join(tmpRoot, "previews");
      fs.mkdirSync(previews, { recursive: true });
      for (const ext of ["jpg", "webp", "png"]) {
        fs.writeFileSync(path.join(previews, `shot.png.${ext}`), "stale");
      }
      // A small image now lives at the path → no new preview, stale ones gone.
      await expect(writePreview(original, "https://example.com/x.png", 100_000)).resolves.toBeUndefined();
      expect(fs.readdirSync(previews)).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("previews only large images", () => {
    expect(shouldWritePreview("media/shot.png", 5_000_000)).toBe(true);
    expect(shouldWritePreview("media/shot.PNG", 5_000_000)).toBe(true);
    expect(shouldWritePreview("media/shot.png", 100_000)).toBe(false); // already small
    expect(shouldWritePreview("media/clip.mp4", 50_000_000)).toBe(false); // not an image
    expect(shouldWritePreview("media/anim.gif", 5_000_000)).toBe(false); // animation
  });

  it("writePreview is best-effort and never throws", async () => {
    // Non-image → skipped without touching the filesystem or network.
    await expect(writePreview("media/clip.mp4", "https://cdn.videodraft.ai/x.mp4", 50_000_000)).resolves.toBeUndefined();
    // Missing source file + failing fetch → undefined, no throw, no residue.
    // Rooted in a tmp dir: writePreview mkdirs previews/ before its routes run,
    // so a repo-relative path would leave a stray directory in the worktree.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vd-preview-test-"));
    const failingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    try {
      await expect(
        writePreview(path.join(tmpRoot, "shot.png"), "https://cdn.videodraft.ai/x.png", 5_000_000, failingFetch),
      ).resolves.toBeUndefined();
      // The previews dir may exist, but no preview (or temp) file may.
      const previews = path.join(tmpRoot, "previews");
      const leftovers = fs.existsSync(previews) ? fs.readdirSync(previews) : [];
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("stops paying for the CDN route after consecutive failures", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vd-preview-test-"));
    try {
      let fetchCalls = 0;
      const failingFetch = (async () => {
        fetchCalls++;
        throw new Error("optimizer unreachable");
      }) as unknown as typeof fetch;
      // Missing sources force the CDN route (sips can't read them); the
      // breaker trips after 2 consecutive failures and skips the rest.
      for (let i = 0; i < 5; i++) {
        await writePreview(
          path.join(tmpRoot, `shot${i}.png`),
          "https://cdn.videodraft.ai/x.png",
          5_000_000,
          failingFetch,
        );
      }
      expect(fetchCalls).toBe(2);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("savedLine points at the preview when one exists", () => {
    expect(savedLine({ url: "u", path: "media/shot.png", bytes: 9 })).toBe("saved media/shot.png");
    expect(
      savedLine({ url: "u", path: "media/shot.png", bytes: 9, preview: "media/previews/shot.jpg" }),
    ).toBe("saved media/shot.png (inspect via preview: media/previews/shot.jpg)");
  });
});
