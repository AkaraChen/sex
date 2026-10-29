import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compilePatterns, isSkippableFile, matchesPatterns, unsafeRegexReason } from "@searxng-js/sex-map";

describe("unsafeRegexReason", () => {
  for (const pattern of ["(a+)+$", "(a*)*", "(.*a){3,}x", "^(\\w+\\s?)*$", "(a|a)*", "(a|ab)+", "(x+x+)+y"]) {
    test(`rejects ${pattern}`, () => {
      assert.notEqual(unsafeRegexReason(pattern), undefined);
    });
  }
  for (const pattern of ["^/docs/.*", "^/blog/\\d{4}/", "(a|b)+", "(foo|bar)*baz", "^/(en|de)/", "(?=.*x)^/a", "(a+)?", "(a{1,3})+"]) {
    test(`allows ${pattern}`, () => {
      assert.equal(unsafeRegexReason(pattern), undefined);
    });
  }
});

describe("compilePatterns", () => {
  test("rejects too many, too long, invalid and risky patterns", () => {
    assert.throws(() => compilePatterns(Array(101).fill("a"), "includePaths"));
    assert.throws(() => compilePatterns(["a".repeat(1001)], "includePaths"));
    assert.throws(() => compilePatterns(["("], "includePaths"));
    assert.throws(() => compilePatterns(["(a+)+"], "includePaths"), /backtrack/);
    assert.equal(compilePatterns(["^/docs"], "includePaths").length, 1);
  });
});

test("matchesPatterns truncates long targets", () => {
  assert.equal(matchesPatterns(`/${"a".repeat(3000)}b`, [], [/b$/]), true);
  assert.equal(matchesPatterns("/x", [/^\/y/], []), false);
});

test("isSkippableFile keeps pages and documents; images depend on docs", () => {
  const u = (p: string) => new URL(`https://e.com${p}`);
  assert.equal(isSkippableFile(u("/a.zip"), true), true);
  assert.equal(isSkippableFile(u("/a.MP4"), true), true);
  assert.equal(isSkippableFile(u("/a.pdf"), false), false);
  assert.equal(isSkippableFile(u("/a.docx"), false), false);
  assert.equal(isSkippableFile(u("/a.html"), false), false);
  assert.equal(isSkippableFile(u("/a.png"), false), true);
  assert.equal(isSkippableFile(u("/a.png"), true), false);
});
