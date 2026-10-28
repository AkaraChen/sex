import { describe, expect, test } from "bun:test";
import { compilePatterns, isSkippableFile, matchesPatterns, unsafeRegexReason } from "../src/engine/url-filter.ts";

describe("unsafeRegexReason", () => {
  test.each(["(a+)+$", "(a*)*", "(.*a){3,}x", "^(\\w+\\s?)*$", "(a|a)*", "(a|ab)+", "(x+x+)+y"])("rejects %s", (p) => {
    expect(unsafeRegexReason(p)).toBeDefined();
  });
  test.each(["^/docs/.*", "^/blog/\\d{4}/", "(a|b)+", "(foo|bar)*baz", "^/(en|de)/", "(?=.*x)^/a", "(a+)?", "(a{1,3})+"])(
    "allows %s",
    (p) => {
      expect(unsafeRegexReason(p)).toBeUndefined();
    },
  );
});

describe("compilePatterns", () => {
  test("rejects too many, too long, invalid and risky patterns", () => {
    expect(() => compilePatterns(Array(101).fill("a"), "includePaths")).toThrow();
    expect(() => compilePatterns(["a".repeat(1001)], "includePaths")).toThrow();
    expect(() => compilePatterns(["("], "includePaths")).toThrow();
    expect(() => compilePatterns(["(a+)+"], "includePaths")).toThrow(/backtrack/);
    expect(compilePatterns(["^/docs"], "includePaths")).toHaveLength(1);
  });
});

test("matchesPatterns truncates long targets", () => {
  expect(matchesPatterns(`/${"a".repeat(3000)}b`, [], [/b$/])).toBe(true);
  expect(matchesPatterns("/x", [/^\/y/], [])).toBe(false);
});

test("isSkippableFile keeps pages and documents; images depend on docs", () => {
  const u = (p: string) => new URL(`https://e.com${p}`);
  expect(isSkippableFile(u("/a.zip"), true)).toBe(true);
  expect(isSkippableFile(u("/a.MP4"), true)).toBe(true);
  expect(isSkippableFile(u("/a.pdf"), false)).toBe(false);
  expect(isSkippableFile(u("/a.docx"), false)).toBe(false);
  expect(isSkippableFile(u("/a.html"), false)).toBe(false);
  expect(isSkippableFile(u("/a.png"), false)).toBe(true);
  expect(isSkippableFile(u("/a.png"), true)).toBe(false);
});
