import { describe, expect, test } from "bun:test";
import { isPrivateIp } from "@sex/core/egress.ts";
import { AppError } from "@sex/core/errors.ts";
import { normalizeFormats } from "@sex/core/scrape.ts";
import { parseRobots } from "../src/engine/robots.ts";

describe("isPrivateIp", () => {
  test.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.20.0.1", true],
    ["192.168.1.1", true],
    ["169.254.169.254", true],
    ["100.64.0.1", true],
    ["::1", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true],
    ["8.8.8.8", false],
    ["172.32.0.1", false],
    ["2606:4700::1111", false],
  ])("%s -> %p", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

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
    expect(robots.isAllowed("https://example.com/")).toBe(true);
    expect(robots.isAllowed("https://example.com/private/x")).toBe(false);
    expect(robots.isAllowed("https://example.com/private/public/y")).toBe(true);
  });

  test("wildcards and end anchors", () => {
    expect(robots.isAllowed("https://example.com/a/b.pdf")).toBe(false);
    expect(robots.isAllowed("https://example.com/a/b.pdf?x=1")).toBe(true);
  });

  test("specific user-agent groups take precedence", () => {
    expect(parseRobots("User-agent: sexbot\nDisallow: /\n\nUser-agent: *\nAllow: /", "sexbot").isAllowed("https://e.com/x")).toBe(false);
  });

  test("collects sitemaps", () => {
    expect(robots.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });
});

describe("normalizeFormats", () => {
  test("defaults to markdown", () => {
    expect(normalizeFormats(undefined).markdown).toBe(true);
  });

  test("parses object formats", () => {
    const f = normalizeFormats(["html", { type: "json", prompt: "p" }, { type: "question", question: "q?" }]);
    expect(f.markdown).toBe(false);
    expect(f.html).toBe(true);
    expect(f.json).toEqual({ prompt: "p", schema: undefined });
    expect(f.question).toBe("q?");
  });

  test("rejects unsupported formats with 501", () => {
    try {
      normalizeFormats(["screenshot"]);
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(501);
    }
  });
});
