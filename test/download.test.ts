import path from "node:path";
import { describe, expect, it } from "vitest";
import { extFromUrl, renderTemplate } from "../src/core/download.js";

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
