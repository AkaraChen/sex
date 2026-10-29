import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseRobots } from "@searxng-js/sex-map";

describe("parseRobots", () => {
  const robots = parseRobots(
    `User-agent: *
Disallow: /private/
Allow: /private/public
Disallow: /*.pdf$

User-agent: sexbot
Disallow: /

Sitemap: https://example.com/sitemap.xml`,
    "sex",
  );

  test("longest match wins, allow beats disallow on ties", () => {
    assert.equal(robots.isAllowed("https://example.com/"), true);
    assert.equal(robots.isAllowed("https://example.com/private/x"), false);
    assert.equal(robots.isAllowed("https://example.com/private/public/y"), true);
  });

  test("wildcards and end anchors", () => {
    assert.equal(robots.isAllowed("https://example.com/a/b.pdf"), false);
    assert.equal(robots.isAllowed("https://example.com/a/b.pdf?x=1"), true);
  });

  test("specific user-agent groups take precedence", () => {
    assert.equal(parseRobots("User-agent: sexbot\nDisallow: /\n\nUser-agent: *\nAllow: /", "sexbot").isAllowed("https://e.com/x"), false);
  });

  test("collects sitemaps", () => {
    assert.deepEqual(robots.sitemaps, ["https://example.com/sitemap.xml"]);
  });
});
