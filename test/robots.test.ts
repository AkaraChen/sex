import { describe, expect, test } from "bun:test";
import { parseRobots } from "../src/core/robots.ts";

const block = (rules: string) => parseRobots(`User-agent: *\n${rules}`, "sex");

describe("robots matching", () => {
  test("many wildcards complete in linear time", () => {
    const robots = block(`Disallow: ${"/*x".repeat(12)}y$`);
    const url = `https://e.com/${"x".repeat(200)}`;
    const start = performance.now();
    const allowed = robots.isAllowed(url);
    const elapsed = performance.now() - start;
    expect(allowed).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });

  test("special characters are literal", () => {
    const dot = block("Disallow: /a.b");
    expect(dot.isAllowed("https://e.com/a.b/c")).toBe(false);
    expect(dot.isAllowed("https://e.com/axb")).toBe(true);

    const query = block("Disallow: /*?");
    expect(query.isAllowed("https://e.com/page?x=1")).toBe(false);
    expect(query.isAllowed("https://e.com/page")).toBe(true);

    const plus = block("Disallow: /a+b");
    expect(plus.isAllowed("https://e.com/a+b")).toBe(false);
  });

  test("end anchor", () => {
    const robots = block("Disallow: /*.pdf$");
    expect(robots.isAllowed("https://e.com/x.pdf")).toBe(false);
    expect(robots.isAllowed("https://e.com/x.pdf?y=1")).toBe(true);
  });

  test("longest match wins, allow beats disallow on ties", () => {
    const robots = block("Disallow: /private/\nAllow: /private/public\nDisallow: /*.pdf$");
    expect(robots.isAllowed("https://example.com/")).toBe(true);
    expect(robots.isAllowed("https://example.com/private/x")).toBe(false);
    expect(robots.isAllowed("https://example.com/private/public/y")).toBe(true);
    expect(robots.isAllowed("https://example.com/a/b.pdf")).toBe(false);
    expect(robots.isAllowed("https://example.com/a/b.pdf?x=1")).toBe(true);

    const tie = block("Disallow: /dup\nAllow: /dup");
    expect(tie.isAllowed("https://e.com/dup")).toBe(true);
  });
});
