import { describe, expect, it } from "vitest";
import { buildMediaDescriptors } from "../src/core/media.js";

describe("buildMediaDescriptors", () => {
  it("resolves kind from the server type hint first", () => {
    expect(buildMediaDescriptors(["https://cdn.videodraft.ai/u/x/asset"], "video")).toEqual([
      { kind: "video", url: "https://cdn.videodraft.ai/u/x/asset" },
    ]);
    expect(buildMediaDescriptors(["https://cdn.videodraft.ai/u/x/asset"], "image")).toEqual([
      { kind: "image", url: "https://cdn.videodraft.ai/u/x/asset" },
    ]);
  });

  it("maps music / voiceover / speech / tts hints to audio", () => {
    for (const hint of ["music", "sound", "voiceover", "speech", "tts", "audio"]) {
      expect(buildMediaDescriptors(["https://cdn.videodraft.ai/a"], hint)).toEqual([
        { kind: "audio", url: "https://cdn.videodraft.ai/a" },
      ]);
    }
  });

  it("falls back to the CDN path category, then the extension", () => {
    expect(buildMediaDescriptors(["https://cdn.videodraft.ai/u/img/c1.png"])).toEqual([
      { kind: "image", url: "https://cdn.videodraft.ai/u/img/c1.png" },
    ]);
    expect(buildMediaDescriptors(["https://cdn.videodraft.ai/u/vid/c1.mp4"])).toEqual([
      { kind: "video", url: "https://cdn.videodraft.ai/u/vid/c1.mp4" },
    ]);
    // category wins over a misleading extension is not asserted; here only an
    // extension is available:
    expect(buildMediaDescriptors(["https://cdn.videodraft.ai/u/clip.webm"])).toEqual([
      { kind: "video", url: "https://cdn.videodraft.ai/u/clip.webm" },
    ]);
    expect(buildMediaDescriptors(["https://cdn.videodraft.ai/u/track.mp3"])).toEqual([
      { kind: "audio", url: "https://cdn.videodraft.ai/u/track.mp3" },
    ]);
  });

  it("ignores extension query strings when sniffing", () => {
    expect(buildMediaDescriptors(["https://cdn.videodraft.ai/u/x.png?sig=abc"])).toEqual([
      { kind: "image", url: "https://cdn.videodraft.ai/u/x.png?sig=abc" },
    ]);
  });

  it("dedupes and drops non-http / unresolvable urls", () => {
    expect(
      buildMediaDescriptors([
        "https://cdn.videodraft.ai/u/img/a.png",
        "https://cdn.videodraft.ai/u/img/a.png", // dup
        "data:image/png;base64,xxx", // not http
        "https://cdn.videodraft.ai/u/unknown", // no kind resolvable
      ]),
    ).toEqual([{ kind: "image", url: "https://cdn.videodraft.ai/u/img/a.png" }]);
  });

  it("returns [] for missing input", () => {
    expect(buildMediaDescriptors(undefined)).toEqual([]);
    expect(buildMediaDescriptors([])).toEqual([]);
  });
});
