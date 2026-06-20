import { describe, expect, it } from "vitest";
import { coerceArgValue, parseKeyValueArgs } from "../src/commands/tools.js";
import { parseDuration } from "../src/cli/context.js";

describe("coerceArgValue", () => {
  it("parses JSON scalars and structures", () => {
    expect(coerceArgValue("2")).toBe(2);
    expect(coerceArgValue("true")).toBe(true);
    expect(coerceArgValue('["a","b"]')).toEqual(["a", "b"]);
    expect(coerceArgValue('{"x":1}')).toEqual({ x: 1 });
    expect(coerceArgValue('"quoted"')).toBe("quoted");
  });
  it("keeps non-JSON as plain strings", () => {
    expect(coerceArgValue("a red fox")).toBe("a red fox");
    expect(coerceArgValue("16:9")).toBe("16:9");
    expect(coerceArgValue("proj_abc-123")).toBe("proj_abc-123");
  });
});

describe("parseKeyValueArgs", () => {
  it("builds an args object from key=value pairs", () => {
    expect(parseKeyValueArgs(["prompt=a red fox", "num_images=2", "grid=true"])).toEqual({
      prompt: "a red fox",
      num_images: 2,
      grid: true,
    });
  });
  it("keeps = inside values", () => {
    expect(parseKeyValueArgs(["url=https://x.test/a?b=c"])).toEqual({ url: "https://x.test/a?b=c" });
  });
  it("rejects pairs without a key", () => {
    expect(() => parseKeyValueArgs(["=oops"])).toThrow();
    expect(() => parseKeyValueArgs(["nokey"])).toThrow();
  });
});

describe("parseDuration", () => {
  it("parses common forms", () => {
    expect(parseDuration("3s", 0)).toBe(3000);
    expect(parseDuration("10m", 0)).toBe(600000);
    expect(parseDuration("500ms", 0)).toBe(500);
    expect(parseDuration("45", 0)).toBe(45000);
  });
  it("falls back on garbage", () => {
    expect(parseDuration("soon", 1234)).toBe(1234);
    expect(parseDuration(undefined, 1234)).toBe(1234);
  });
});
