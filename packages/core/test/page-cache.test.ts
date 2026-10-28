import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BrowserScrapeOptions, BrowserScrapeResult, CachedPage, CacheKey, ScrapeBrowser, ScrapeCache } from "../src/capabilities.ts";
import { AppError } from "../src/errors.ts";
import { extractFromHtmlInline } from "../src/page.ts";
import { testCoreEngine, textPdf } from "./helpers.ts";

/** A cache in a Map with a clock the test moves; the same age rules as the real one. */
class MapCache implements ScrapeCache {
  now = 1_000_000;
  readonly entries = new Map<string, CachedPage & { storedAt: number }>();
  gets: Array<{ key: CacheKey; age: { minAge?: number; maxAge: number } }> = [];
  constructor(
    readonly defaultMaxAge = 0,
    readonly retention = 1_000_000,
  ) {}
  async get(key: CacheKey, age: { minAge?: number; maxAge: number }) {
    this.gets.push({ key, age });
    const e = this.entries.get(JSON.stringify(key));
    const old = e && this.now - e.storedAt;
    return e && old !== undefined && old >= (age.minAge ?? 0) && old <= age.maxAge ? e : undefined;
  }
  async put(key: CacheKey, page: CachedPage) {
    this.entries.set(JSON.stringify(key), { ...page, storedAt: this.now });
  }
}

/** A browser that renders `html` and counts its calls. */
function renderingBrowser(html: string) {
  const browser = {
    enabled: true,
    calls: 0,
    scrape: async (opts: BrowserScrapeOptions): Promise<BrowserScrapeResult> => {
      browser.calls++;
      return {
        url: opts.url,
        status: 200,
        contentType: "text/html",
        rawHtml: html,
        extracted: await extractFromHtmlInline(html, { ...opts.extract, url: opts.url }),
      };
    },
  };
  return browser satisfies ScrapeBrowser;
}

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected rejection");
}

describe("page cache (core)", () => {
  let hits: Record<string, number>;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  beforeAll(() => {
    hits = {};
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        hits[pathname] = (hits[pathname] ?? 0) + 1;
        const html = (s: string) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (pathname === "/page") {
          return html(
            `<html><head><title>Page</title></head><body><main><h1>Page</h1>${"<p>Some words about the page, many. </p>".repeat(8)}<a href="/other">other</a></main></body></html>`,
          );
        }
        if (pathname === "/missing") return new Response("gone", { status: 404 });
        if (pathname === "/file.pdf") return new Response(textPdf(3), { headers: { "content-type": "application/pdf" } });
        return new Response("not found", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    server.stop(true);
    await Promise.all(engines.map((e) => e.close()));
  });

  /** A fresh engine over `cache`, and the scrape function bound to it. */
  const engines: Array<{ close(): Promise<void> }> = [];
  const setup = (cache: MapCache | undefined) => {
    const e = testCoreEngine();
    engines.push(e);
    Object.assign(e, { cache });
    const scrape = (path: string, options: Record<string, unknown> = {}) => e.scrape({ url: `${base}${path}`, ...options });
    return { e, scrape };
  };
  const count = (path: string) => hits[path] ?? 0;
  const fresh = (path: string) => {
    hits[path] = 0;
  };

  test("without maxAge nothing is read or stored (the server default is 0)", async () => {
    const cache = new MapCache();
    const { scrape } = setup(cache);
    fresh("/page");
    const a = await scrape("/page");
    const b = await scrape("/page");
    expect(count("/page")).toBe(2);
    expect(a.metadata?.cacheState).toBe("miss");
    expect(b.metadata?.cacheState).toBe("miss");
    expect(cache.entries.size).toBe(0);
    expect(cache.gets).toHaveLength(0);
  });

  test("maxAge stores on a miss and answers the next request from the cache", async () => {
    const cache = new MapCache();
    const { scrape } = setup(cache);
    fresh("/page");
    const first = await scrape("/page", { maxAge: 60_000 });
    expect(first.metadata?.cacheState).toBe("miss");
    expect(first.metadata?.cachedAt).toBeUndefined();
    cache.now += 5_000;
    const second = await scrape("/page", { maxAge: 60_000 });
    expect(count("/page")).toBe(1);
    expect(second.metadata?.cacheState).toBe("hit");
    expect(second.metadata?.cachedAt).toBe(new Date(1_000_000).toISOString());
    expect(second.markdown).toBe(first.markdown);
    expect(second.metadata?.statusCode).toBe(200);
    expect(second.metadata?.sourceURL).toBe(`${base}/page`);
    expect(second.metadata?.scrapeId).not.toBe(first.metadata?.scrapeId);
  });

  test("the server default maxAge applies when the request has none; an entry older than maxAge is fetched again", async () => {
    const cache = new MapCache(10_000);
    const { scrape } = setup(cache);
    fresh("/page");
    await scrape("/page");
    cache.now += 5_000;
    expect((await scrape("/page")).metadata?.cacheState).toBe("hit");
    cache.now += 6_000;
    expect((await scrape("/page")).metadata?.cacheState).toBe("miss");
    expect(count("/page")).toBe(2);
    // The miss stored a new copy.
    expect((await scrape("/page")).metadata?.cacheState).toBe("hit");
  });

  test("maxAge is capped at the retention", async () => {
    const cache = new MapCache(0, 5_000);
    const { scrape } = setup(cache);
    fresh("/page");
    await scrape("/page", { maxAge: 99_999_999 });
    expect(cache.gets.at(-1)?.age.maxAge).toBe(5_000);
  });

  test("maxAge 0 does not read but stores, so it refreshes the entry", async () => {
    const cache = new MapCache();
    const { e } = setup(cache);
    const body = { v: "first" };
    const local = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<html><head><title>T</title></head><body><main><h1>T</h1>${`<p>${body.v} version of the text. </p>`.repeat(8)}</main></body></html>`,
          {
            headers: { "content-type": "text/html" },
          },
        ),
    });
    try {
      const url = `http://127.0.0.1:${local.port}/x`;
      const get = (options: Record<string, unknown>) => e.scrape({ url, ...options });
      const a = await get({ maxAge: 0 });
      expect(a.metadata?.cacheState).toBe("miss");
      expect(cache.gets).toHaveLength(0);
      expect(cache.entries.size).toBe(1);
      body.v = "second";
      const b = await get({ maxAge: 60_000 });
      expect(b.metadata?.cacheState).toBe("hit");
      expect(b.markdown).toContain("first version");
      // maxAge 0 again replaces it with the current page.
      expect((await get({ maxAge: 0 })).markdown).toContain("second version");
      expect((await get({ maxAge: 60_000 })).markdown).toContain("second version");
      // ...unless it is told not to store.
      body.v = "third";
      await get({ maxAge: 0, storeInCache: false });
      expect((await get({ maxAge: 60_000 })).markdown).toContain("second version");
    } finally {
      local.stop(true);
    }
  });

  test("storeInCache: false reads the cache but does not store", async () => {
    const cache = new MapCache();
    const { scrape } = setup(cache);
    fresh("/page");
    await scrape("/page", { maxAge: 60_000, storeInCache: false });
    expect(cache.entries.size).toBe(0);
    await scrape("/page", { maxAge: 60_000 });
    expect((await scrape("/page", { maxAge: 60_000, storeInCache: false })).metadata?.cacheState).toBe("hit");
  });

  test("formats are applied to the stored page, so a different format request still hits", async () => {
    const cache = new MapCache();
    const { scrape } = setup(cache);
    fresh("/page");
    await scrape("/page", { maxAge: 60_000, formats: ["markdown"] });
    const doc = await scrape("/page", { maxAge: 60_000, formats: ["links", "rawHtml", "html"] });
    expect(count("/page")).toBe(1);
    expect(doc.metadata?.cacheState).toBe("hit");
    expect(doc.links).toEqual([`${base}/other`]);
    expect(doc.rawHtml).toContain("<title>Page</title>");
    expect(doc.markdown).toBeUndefined();
  });

  test("variants that change the page do not share an entry; custom headers and 404s are not cached", async () => {
    const cache = new MapCache();
    const { scrape } = setup(cache);
    fresh("/page");
    await scrape("/page", { maxAge: 60_000 });
    expect((await scrape("/page", { maxAge: 60_000, mobile: true })).metadata?.cacheState).toBe("miss");
    expect((await scrape("/page", { maxAge: 60_000, skipTlsVerification: true })).metadata?.cacheState).toBe("miss");
    expect((await scrape("/page", { maxAge: 60_000, location: { languages: ["de"] } })).metadata?.cacheState).toBe("miss");
    expect((await scrape("/page", { maxAge: 60_000, mobile: true })).metadata?.cacheState).toBe("hit");
    expect(cache.entries.size).toBe(4);

    const gets = cache.gets.length;
    await scrape("/page", { maxAge: 60_000, headers: { "x-token": "a" } });
    expect(cache.gets).toHaveLength(gets);
    expect(cache.entries.size).toBe(4);

    await scrape("/missing", { maxAge: 60_000 }).catch(() => undefined);
    expect([...cache.entries.keys()].some((k) => k.includes("/missing"))).toBe(false);
    // The URL fragment is not part of the page.
    expect((await scrape("/page#section", { maxAge: 60_000 })).metadata?.cacheState).toBe("hit");
  });

  test("a PDF is cached as bytes, so a different maxPages is answered from the same entry", async () => {
    const cache = new MapCache();
    const { scrape } = setup(cache);
    fresh("/file.pdf");
    const one = await scrape("/file.pdf", { maxAge: 60_000, parsers: [{ type: "pdf", maxPages: 1 }] });
    const all = await scrape("/file.pdf", { maxAge: 60_000 });
    expect(count("/file.pdf")).toBe(1);
    expect(all.metadata?.cacheState).toBe("hit");
    expect(one.markdown).toContain("Text page 1");
    expect(one.markdown).not.toContain("Text page 2");
    expect(all.markdown).toContain("Text page 3");
  });

  test("rawBase64 and uploads bypass the cache", async () => {
    const cache = new MapCache();
    const { scrape } = setup(cache);
    await scrape("/page", { maxAge: 60_000, formats: ["rawBase64"] });
    expect(cache.entries.size).toBe(0);
    expect(cache.gets).toHaveLength(0);
  });

  describe("lockdown and minAge", () => {
    test("read only: a miss is 404 SCRAPE_NO_CACHED_DATA and nothing is fetched", async () => {
      const cache = new MapCache();
      const { scrape } = setup(cache);
      fresh("/page");
      for (const options of [
        { lockdown: true },
        { minAge: 0 },
        { lockdown: true, headers: { a: "b" } },
        { minAge: 1, formats: ["rawBase64"] },
      ]) {
        const err = await rejection(scrape("/page", options));
        expect([err.status, err.code]).toEqual([404, "SCRAPE_NO_CACHED_DATA"]);
      }
      expect(count("/page")).toBe(0);
      expect(cache.entries.size).toBe(0);
    });

    test("a stored page is returned as a hit, without maxAge up to the retention", async () => {
      const cache = new MapCache(0, 100_000);
      const { scrape } = setup(cache);
      fresh("/page");
      await scrape("/page", { maxAge: 60_000 });
      cache.now += 80_000;
      const doc = await scrape("/page", { lockdown: true });
      expect(doc.metadata?.cacheState).toBe("hit");
      expect(count("/page")).toBe(1);
      expect(cache.gets.at(-1)?.age).toEqual({ minAge: undefined, maxAge: 100_000 });
    });

    test("minAge wants an entry at least that old, maxAge at most", async () => {
      const cache = new MapCache();
      const { scrape } = setup(cache);
      await scrape("/page", { maxAge: 60_000 });
      cache.now += 10_000;
      expect((await rejection(scrape("/page", { minAge: 20_000 }))).code).toBe("SCRAPE_NO_CACHED_DATA");
      cache.now += 15_000;
      expect((await scrape("/page", { minAge: 20_000 })).metadata?.cacheState).toBe("hit");
      expect((await rejection(scrape("/page", { minAge: 20_000, maxAge: 22_000 }))).code).toBe("SCRAPE_NO_CACHED_DATA");
      expect((await rejection(scrape("/page", { lockdown: true, maxAge: 0 }))).code).toBe("SCRAPE_NO_CACHED_DATA");
    });

    test("never stores", async () => {
      const cache = new MapCache();
      const { scrape } = setup(cache);
      await rejection(scrape("/page", { lockdown: true, maxAge: 60_000 }));
      expect(cache.entries.size).toBe(0);
    });
  });

  describe("with a browser", () => {
    const rendered = `<html><head><title>Rendered</title></head><body><main><h1>Rendered</h1>${"<p>Script made this text, a lot. </p>".repeat(8)}</main></body></html>`;

    test("the rendered HTML is what is stored: a hit does not call the browser, and actions are never cached", async () => {
      const cache = new MapCache();
      const { e, scrape } = setup(cache);
      const browser = renderingBrowser(rendered);
      Object.assign(e, { browser });
      fresh("/page");
      const first = await scrape("/page", { maxAge: 60_000 });
      const second = await scrape("/page", { maxAge: 60_000 });
      expect(browser.calls).toBe(1);
      expect(count("/page")).toBe(0);
      expect(second.metadata?.cacheState).toBe("hit");
      expect(second.markdown).toContain("Script made this text");
      expect(second.markdown).toBe(first.markdown);

      await scrape("/page", { maxAge: 60_000, actions: [{ type: "wait", milliseconds: 1 }] });
      expect(browser.calls).toBe(2);
      expect(cache.entries.size).toBe(1);
    });

    test("rendered and plain pages are separate entries; blockAds and waitFor split rendered ones", async () => {
      const cache = new MapCache();
      const { e, scrape } = setup(cache);
      Object.assign(e, { browser: renderingBrowser(rendered) });
      await scrape("/page", { maxAge: 60_000 });
      expect((await scrape("/page", { maxAge: 60_000, fastMode: true })).metadata?.cacheState).toBe("miss");
      expect((await scrape("/page", { maxAge: 60_000, blockAds: false })).metadata?.cacheState).toBe("miss");
      expect((await scrape("/page", { maxAge: 60_000, waitFor: 10 })).metadata?.cacheState).toBe("miss");
      expect((await scrape("/page", { maxAge: 60_000, fastMode: true })).metadata?.cacheState).toBe("hit");
      expect(cache.entries.size).toBe(4);
    });

    test("a cached render does not warn that waitFor or mobile were ignored", async () => {
      const cache = new MapCache();
      const { e, scrape } = setup(cache);
      Object.assign(e, { browser: renderingBrowser(rendered) });
      const options = { maxAge: 60_000, mobile: true, waitFor: 10 };
      await scrape("/page", options);
      const hit = await scrape("/page", options);
      expect(hit.metadata?.cacheState).toBe("hit");
      expect(hit.warning).toBeUndefined();
    });
  });
});
