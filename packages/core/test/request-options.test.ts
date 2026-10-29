import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppError } from "@searxng-js/sex-errors";
import type { BrowserScrapeOptions, BrowserScrapeResult, ScrapeBrowser } from "../src/capabilities.ts";
import { BaseEngine } from "../src/engine.ts";
import { ScrapeOptions } from "../src/schemas.ts";
import { startFixtureSite, startMockSearxng, testCoreConfig, testCoreEngine } from "./helpers.ts";

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (AppError.isInstance(err)) return err;
    throw err;
  }
  throw new Error("expected rejection");
}

const outcome = (err: AppError) => ({ status: err.status, code: err.code });

/** A browser that counts its calls and renders the same page every time. */
function countingBrowser() {
  const browser = {
    enabled: true,
    calls: 0,
    scrape: async (_opts: BrowserScrapeOptions): Promise<BrowserScrapeResult> => {
      browser.calls++;
      return {
        url: "http://rendered.test/",
        status: 200,
        contentType: "text/html",
        rawHtml: "<html></html>",
        extracted: {
          metadata: {},
          attributes: [],
          html: "",
          markdown: "rendered",
          notes: [],
          defuddle: { title: "", description: "", author: "", published: "", site: "", image: "", language: "", wordCount: 0 },
        },
      };
    },
  };
  return browser satisfies ScrapeBrowser;
}

describe("request options", () => {
  const engine = testCoreEngine();
  let site: ReturnType<typeof startFixtureSite>;
  beforeAll(() => {
    site = startFixtureSite();
  });
  afterAll(async () => {
    site.stop();
    await engine.close();
  });
  const scrape = (options: Record<string, unknown>, path = "/docs/b") => engine.scrape({ url: `${site.url}${path}`, ...options });

  test.each([
    ["redactPII", true],
    ["redactPII", { mode: "fast" }],
    ["zeroDataRetention", true],
    ["onlyCleanContent", true],
  ])("%s=%j is a 501 instead of being dropped", async (name, value) => {
    expect(outcome(await rejection(scrape({ [name]: value })))).toEqual({ status: 501, code: "NOT_SUPPORTED" });
  });

  test("false values of the unsupported options are fine", async () => {
    const doc = await scrape({ redactPII: false, zeroDataRetention: false, onlyCleanContent: false, lockdown: false });
    expect(doc.markdown).toContain("doc b");
  });

  test("lockdown and minAge are cache-only, and there is no cache: 404 SCRAPE_NO_CACHED_DATA", async () => {
    for (const options of [{ lockdown: true }, { minAge: 0 }, { minAge: 60_000 }]) {
      expect(outcome(await rejection(scrape(options)))).toEqual({ status: 404, code: "SCRAPE_NO_CACHED_DATA" });
    }
  });

  test("deterministicJson is a 501", async () => {
    expect(outcome(await rejection(scrape({ formats: ["deterministicJson"] })))).toEqual({ status: 501, code: "NOT_SUPPORTED" });
  });

  test("proxy, parsers and unknown pdf parser options are validated", () => {
    expect(ScrapeOptions.safeParse({ proxy: "auto" }).success).toBe(true);
    expect(ScrapeOptions.safeParse({ proxy: "residential" }).success).toBe(false);
    expect(ScrapeOptions.safeParse({ parsers: ["pdf", { type: "pdf", maxPages: 2 }, "image"] }).success).toBe(true);
    expect(ScrapeOptions.safeParse({ parsers: ["pfd"] }).success).toBe(false);
    expect(ScrapeOptions.safeParse({ parsers: [{ type: "pdf", maxPage: 2 }] }).success).toBe(false);
  });

  test("options that have no effect say so in warning", async () => {
    const doc = await scrape({
      proxy: "stealth",
      location: { country: "DE" },
      mobile: true,
      formats: ["markdown"],
      parsers: [{ type: "pdf", blocks: true, refresh: true }],
    });
    const warning = doc.warning ?? "";
    expect(warning).toContain('proxy "stealth" is not available');
    expect(warning).toContain("location.country is not used for geo-targeting");
    expect(warning).toContain("mobile only changes the User-Agent");
    expect(warning).toContain("blocks, refresh");
    expect(warning.match(/your scrape may be partial/g)).toHaveLength(3);
  });

  test("a request with only supported options has no warning", async () => {
    expect((await scrape({ proxy: "basic", maxAge: 1000, storeInCache: false })).warning).toBeUndefined();
  });

  describe("rawBase64", () => {
    test("returns the bytes of the file as base64, and no other format", async () => {
      const doc = await scrape({ formats: ["rawBase64"] }, "/data.json");
      expect(JSON.parse(Buffer.from(doc.rawBase64 ?? "", "base64").toString())).toEqual({ hello: "world" });
      expect(doc.markdown).toBeUndefined();
      expect(doc.metadata?.contentType).toBe("application/json");
      expect(doc.metadata?.statusCode).toBe(200);
    });

    test("cannot be combined with other formats, the guard or actions", async () => {
      for (const options of [
        { formats: ["rawBase64", "markdown"] },
        { formats: ["rawBase64"], checkPromptInjection: true },
        { formats: ["rawBase64"], actions: [{ type: "wait", milliseconds: 10 }] },
      ]) {
        expect((await rejection(scrape(options))).status).toBe(400);
      }
    });

    test("is fetched with safeFetch even when a browser is configured", async () => {
      const browser = countingBrowser();
      const withBrowser = new BaseEngine(testCoreConfig());
      Object.assign(withBrowser, { browser });
      const doc = await withBrowser.scrape({ url: `${site.url}/docs/b`, formats: ["rawBase64"] });
      expect(Buffer.from(doc.rawBase64 ?? "", "base64").toString()).toContain("<html");
      expect(browser.calls).toBe(0);
      await withBrowser.close();
    });
  });

  describe("fastMode", () => {
    test("skips the browser", async () => {
      const browser = countingBrowser();
      const withBrowser = new BaseEngine(testCoreConfig());
      Object.assign(withBrowser, { browser });
      const fast = await withBrowser.scrape({ url: `${site.url}/docs/b`, fastMode: true });
      expect(fast.markdown).toContain("doc b");
      expect(browser.calls).toBe(0);
      const slow = await withBrowser.scrape({ url: `${site.url}/docs/b` });
      expect(slow.markdown).toContain("rendered");
      expect(browser.calls).toBe(1);
      await withBrowser.close();
    });

    test("cannot be combined with actions, which need the browser", async () => {
      const withBrowser = new BaseEngine(testCoreConfig());
      Object.assign(withBrowser, { browser: countingBrowser() });
      const err = await rejection(
        withBrowser.scrape({ url: `${site.url}/docs/b`, fastMode: true, actions: [{ type: "wait", milliseconds: 10 }] }),
      );
      expect(err.status).toBe(400);
      await withBrowser.close();
    });

    test("is accepted without a browser", async () => {
      expect((await scrape({ fastMode: true })).markdown).toContain("doc b");
    });
  });
});

describe("search options", () => {
  let site: ReturnType<typeof startFixtureSite>;
  let searx: ReturnType<typeof startMockSearxng>;
  let engine: BaseEngine;
  beforeAll(() => {
    site = startFixtureSite();
    searx = startMockSearxng(site.url);
    engine = testCoreEngine({ searxngUrl: searx.url });
  });
  afterAll(async () => {
    await engine.close();
    site.stop();
    searx.stop();
  });

  test("zeroDataRetention is a 501", async () => {
    expect(outcome(await rejection(engine.search({ query: "docs", zeroDataRetention: true })))).toEqual({
      status: 501,
      code: "NOT_SUPPORTED",
    });
  });
});
