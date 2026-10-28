import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BrowserScrapeOptions, BrowserScrapeResult, ScrapeBrowser } from "../src/capabilities.ts";
import { AppError, ERRORS, type ErrorCode } from "../src/errors.ts";
import type { PageExtractResult } from "../src/page.ts";
import { type ScrapeContext, scrapeUrl } from "../src/scrape.ts";
import { startFixtureSite, testCoreEngine } from "./helpers.ts";

const extracted = (markdown: string): PageExtractResult => ({
  metadata: {},
  attributes: [],
  html: "",
  markdown,
  notes: [],
  defuddle: { title: "", description: "", author: "", published: "", site: "", image: "", language: "", wordCount: 0 },
});

const rendered = (url: string, markdown: string, status = 200): BrowserScrapeResult => ({
  url,
  status,
  contentType: "text/html",
  rawHtml: "<html></html>",
  extracted: extracted(markdown),
});

/** A browser that does what `scrape` says and counts its calls. */
function fakeBrowser(scrape: (opts: BrowserScrapeOptions) => Promise<BrowserScrapeResult>) {
  const browser = {
    enabled: true,
    calls: 0,
    scrape: (opts: BrowserScrapeOptions) => {
      browser.calls++;
      return scrape(opts);
    },
  };
  return browser satisfies ScrapeBrowser;
}

const failing = (code: ErrorCode) => fakeBrowser(async () => Promise.reject(new AppError(code, `fake ${code}`)));

describe("browser failure falls back to plain HTTP", () => {
  const engine = testCoreEngine();
  let site: ReturnType<typeof startFixtureSite>;
  let empty: ReturnType<typeof Bun.serve>;
  let emptyHits = 0;

  beforeAll(() => {
    site = startFixtureSite();
    empty = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        emptyHits++;
        const { pathname } = new URL(req.url);
        const html = "<!doctype html><html><head></head><body></body></html>";
        return new Response(html, { status: pathname === "/gone" ? 404 : 200, headers: { "content-type": "text/html" } });
      },
    });
  });
  afterAll(async () => {
    site.stop();
    empty.stop(true);
    await engine.close();
  });

  const ctxWith = (browser: ScrapeBrowser): ScrapeContext => ({
    config: engine.config,
    scrapeLimit: engine.scrapeLimit,
    extractPool: engine.extractPool,
    browser,
  });
  const url = () => `${site.url}/docs/a`;

  const codes = Object.keys(ERRORS) as ErrorCode[];

  for (const code of codes.filter((c) => ERRORS[c].fallback)) {
    test(`${code} is answered over HTTP, and the warning says why`, async () => {
      const browser = failing(code);
      const { document } = await scrapeUrl(ctxWith(browser), url());
      expect(browser.calls).toBe(1);
      expect(document.markdown).toContain("Paragraph 1 about doc a");
      expect(document.metadata?.statusCode).toBe(200);
      expect(document.warning).toContain("fell back to HTTP fetch");
      expect(document.warning).toContain(`${code}: fake ${code}`);
    });
  }

  for (const code of codes.filter((c) => !ERRORS[c].fallback)) {
    test(`${code} is thrown as it is`, async () => {
      const err = await scrapeUrl(ctxWith(failing(code)), url()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(code);
    });
  }

  test("an error that is not an AppError is not answered over HTTP", async () => {
    const browser = fakeBrowser(async () => Promise.reject(new TypeError("boom")));
    await expect(scrapeUrl(ctxWith(browser), url())).rejects.toThrow("boom");
  });

  test("a request with actions does not fall back", async () => {
    const err = await scrapeUrl(ctxWith(failing("FETCH_FAILED")), url(), { actions: [{ type: "wait", milliseconds: 10 }] }).catch(
      (e: unknown) => e,
    );
    expect((err as AppError).code).toBe("FETCH_FAILED");
  });

  test("a caller that cancelled gets TIMEOUT, not a fetch", async () => {
    const controller = new AbortController();
    const browser = fakeBrowser(async () => {
      controller.abort();
      throw new AppError("FETCH_FAILED", "closed");
    });
    const err = await scrapeUrl(ctxWith(browser), url(), {}, { signal: controller.signal }).catch((e: unknown) => e);
    expect((err as AppError).code).toBe("TIMEOUT");
  });

  test("with too little time left the browser's error stands", async () => {
    const err = await scrapeUrl(ctxWith(failing("BROWSER_UNAVAILABLE")), url(), { timeout: 1_000 }).catch((e: unknown) => e);
    expect((err as AppError).code).toBe("BROWSER_UNAVAILABLE");
  });

  test("the fetch shares the scrape's deadline: a fetch that runs out of time is SCRAPE_TIMEOUT", async () => {
    const slow = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
    try {
      const started = Date.now();
      const err = await scrapeUrl(ctxWith(failing("FETCH_FAILED")), `http://127.0.0.1:${slow.port}/`, { timeout: 2_300 }).catch(
        (e: unknown) => e,
      );
      expect((err as AppError).code).toBe("SCRAPE_TIMEOUT");
      expect(Date.now() - started).toBeLessThan(3_500);
    } finally {
      slow.stop(true);
    }
  });

  test("when the fetch fails too, its error is the one reported", async () => {
    const err = await scrapeUrl(ctxWith(failing("BROWSER_UNAVAILABLE")), "http://127.0.0.1:1/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).not.toBe("BROWSER_UNAVAILABLE");
  });

  test("a 2xx page without content is fetched over HTTP", async () => {
    const browser = fakeBrowser(async (o) => rendered(o.url, "  \n"));
    const { document } = await scrapeUrl(ctxWith(browser), url());
    expect(document.markdown).toContain("Paragraph 1 about doc a");
    expect(document.warning).toContain("Browser returned no content; fell back to HTTP fetch");
  });

  test("an empty page that is empty over HTTP too keeps the browser's answer", async () => {
    const browser = fakeBrowser(async (o) => rendered(o.url, ""));
    const before = emptyHits;
    const { document } = await scrapeUrl(ctxWith(browser), `http://127.0.0.1:${empty.port}/`);
    expect(emptyHits).toBe(before + 1);
    expect(document.warning).toContain("an HTTP fetch found none either");
  });

  test("a non-2xx empty page is not fetched again", async () => {
    const browser = fakeBrowser(async (o) => rendered(o.url, "", 404));
    const before = emptyHits;
    const { document } = await scrapeUrl(ctxWith(browser), `http://127.0.0.1:${empty.port}/gone`);
    expect(emptyHits).toBe(before);
    expect(document.metadata?.statusCode).toBe(404);
    expect(document.warning).toBeUndefined();
  });

  test("an empty page with actions is not fetched again", async () => {
    const browser = fakeBrowser(async (o) => ({
      ...rendered(o.url, ""),
      actions: { screenshots: [], scrapes: [], javascriptReturns: [], pdfs: [] },
    }));
    const before = emptyHits;
    await scrapeUrl(ctxWith(browser), `http://127.0.0.1:${empty.port}/`, { actions: [{ type: "wait", milliseconds: 10 }] });
    expect(emptyHits).toBe(before);
  });

  test("an empty page with too little time left is not fetched again", async () => {
    const browser = fakeBrowser(async (o) => rendered(o.url, ""));
    const before = emptyHits;
    const { document } = await scrapeUrl(ctxWith(browser), `http://127.0.0.1:${empty.port}/`, { timeout: 1_000 });
    expect(emptyHits).toBe(before);
    expect(document.warning).toBeUndefined();
  });

  test("a page with content is not fetched again", async () => {
    const browser = fakeBrowser(async (o) => rendered(o.url, "Rendered content"));
    const { document } = await scrapeUrl(ctxWith(browser), url());
    expect(document.markdown).toContain("Rendered content");
    expect(document.warning).toBeUndefined();
  });
});
