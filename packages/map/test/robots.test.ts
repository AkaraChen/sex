import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseRobots } from "@searxng-js/sex-map";

const block = (rules: string) => parseRobots(`User-agent: *\n${rules}`, "sex");

describe("robots matching", () => {
  test("many wildcards complete in linear time", () => {
    const robots = block(`Disallow: ${"/*x".repeat(12)}y$`);
    const url = `https://e.com/${"x".repeat(200)}`;
    const start = performance.now();
    const allowed = robots.isAllowed(url);
    const elapsed = performance.now() - start;
    assert.equal(allowed, true);
    assert.ok(elapsed < 50);
  });

  test("special characters are literal", () => {
    const dot = block("Disallow: /a.b");
    assert.equal(dot.isAllowed("https://e.com/a.b/c"), false);
    assert.equal(dot.isAllowed("https://e.com/axb"), true);

    const query = block("Disallow: /*?");
    assert.equal(query.isAllowed("https://e.com/page?x=1"), false);
    assert.equal(query.isAllowed("https://e.com/page"), true);

    const plus = block("Disallow: /a+b");
    assert.equal(plus.isAllowed("https://e.com/a+b"), false);
  });

  test("end anchor", () => {
    const robots = block("Disallow: /*.pdf$");
    assert.equal(robots.isAllowed("https://e.com/x.pdf"), false);
    assert.equal(robots.isAllowed("https://e.com/x.pdf?y=1"), true);
  });

  test("longest match wins, allow beats disallow on ties", () => {
    const robots = block("Disallow: /private/\nAllow: /private/public\nDisallow: /*.pdf$");
    assert.equal(robots.isAllowed("https://example.com/"), true);
    assert.equal(robots.isAllowed("https://example.com/private/x"), false);
    assert.equal(robots.isAllowed("https://example.com/private/public/y"), true);
    assert.equal(robots.isAllowed("https://example.com/a/b.pdf"), false);
    assert.equal(robots.isAllowed("https://example.com/a/b.pdf?x=1"), true);

    const tie = block("Disallow: /dup\nAllow: /dup");
    assert.equal(tie.isAllowed("https://e.com/dup"), true);
  });
});
