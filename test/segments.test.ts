import { describe, expect, it } from "vitest";
import { parseSegments } from "../src/commands/generate.js";

describe("parseSegments (multi_prompt)", () => {
  it("parses prompt:seconds pairs", () => {
    expect(parseSegments(["pan across the city:4", "zoom in on the door:3"])).toEqual([
      { prompt: "pan across the city", duration: 4 },
      { prompt: "zoom in on the door", duration: 3 },
    ]);
  });

  it("splits on the LAST colon so prompts may contain colons", () => {
    expect(parseSegments(["title: the reveal:5"])).toEqual([{ prompt: "title: the reveal", duration: 5 }]);
  });

  it("accepts fractional seconds", () => {
    expect(parseSegments(["quick cut:1.5"])).toEqual([{ prompt: "quick cut", duration: 1.5 }]);
  });

  it("rejects missing/zero/non-numeric durations and empty prompts", () => {
    expect(() => parseSegments(["no duration"])).toThrow();
    expect(() => parseSegments(["bad:abc"])).toThrow();
    expect(() => parseSegments(["zero:0"])).toThrow();
    expect(() => parseSegments([":5"])).toThrow();
    expect(() => parseSegments(["trailing:"])).toThrow();
  });

  it("returns [] for no segments", () => {
    expect(parseSegments([])).toEqual([]);
  });
});
