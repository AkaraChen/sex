import { describe, expect, test } from "bun:test";
import { isPrivateIp } from "@searxng-js/sex-egress";
import { AppError } from "@searxng-js/sex-errors";
import { normalizeFormats } from "@searxng-js/sex-scrape";

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
