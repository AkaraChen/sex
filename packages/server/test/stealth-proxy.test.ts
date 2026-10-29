// SEX_STEALTH_PROXY_URL: a fetch the site blocked is retried once through the second proxy, inside the scrape's deadline.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import type { BrowserScrapeResult, ScrapeBrowser } from "@searxng-js/sex-scrape";
import { type ScrapeContext, scrapeUrl } from "@searxng-js/sex-scrape";
import { resolveCoreConfig } from "../src/config.ts";
import { BaseEngine } from "../src/engine.ts";
import { startCountingProxy, testCoreConfig } from "./helpers.ts";

// A public IP literal needs no DNS lookup to pass the check; the proxies deliver it to the local fixtures instead.
const PUBLIC = "http://93.184.216.34";
const page = (text: string) =>
  `<html><head><title>${text}</title></head><body><main><h1>${text}</h1><p>${text} paragraph one that is long enough to count as content.</p></main></body></html>`;
const html = { "content-type": "text/html" };

describe("stealth proxy retry", () => {
  let wall: ReturnType<typeof Bun.serve>;
  let open: ReturnType<typeof Bun.serve>;
  let basic: Awaited<ReturnType<typeof startCountingProxy>>;
  let stealth: Awaited<ReturnType<typeof startCountingProxy>>;
  const engines: BaseEngine[] = [];

  beforeAll(async () => {
    // What the basic proxy reaches: a bot wall.
    wall = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/limited") return new Response(page("rate limited"), { status: 429, headers: html });
        if (pathname === "/gone") return new Response(page("gone"), { status: 404, headers: html });
        if (pathname === "/ok") return new Response(page("wall ok"), { headers: html });
        return new Response(page("blocked by the wall"), { status: 403, headers: html });
      },
    });
    // What the stealth proxy reaches: the real site.
    open = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/to-private")
          return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${open.port}/secret` } });
        if (pathname === "/secret") return new Response(page("internal secret"), { headers: html });
        if (pathname === "/still-blocked") return new Response(page("blocked again"), { status: 403, headers: html });
        return new Response(page("real content"), { headers: html });
      },
    });
    basic = await startCountingProxy((u) => new URL(`${u.pathname}${u.search}`, `http://127.0.0.1:${wall.port}`));
    stealth = await startCountingProxy((u) => new URL(`${u.pathname}${u.search}`, `http://127.0.0.1:${open.port}`));
  });
  afterAll(async () => {
    wall.stop(true);
    open.stop(true);
    basic.close();
    stealth.close();
    await Promise.all(engines.map((e) => e.close()));
  });
  beforeEach(() => {
    for (const p of [basic, stealth]) {
      p.requests.length = 0;
      p.connects.length = 0;
    }
  });

  const engineWith = (extra: { proxyUrl?: string; stealthProxyUrl?: string; timeout?: number } = {}) => {
    const { timeout, ...proxies } = extra;
    const engine = new BaseEngine({
      ...testCoreConfig({ allowPrivateNetwork: false, ...(timeout ? { timeout } : {}) }),
      proxyUrl: basic.url,
      stealthProxyUrl: stealth.url,
      ...proxies,
    });
    engines.push(engine);
    return engine;
  };

  test("a 403 is retried through the stealth proxy, and the document says so", async () => {
    const doc = await engineWith().scrape({ url: `${PUBLIC}/blocked`, formats: ["markdown"] });
    expect(doc.markdown).toContain("real content");
    expect(doc.metadata?.statusCode).toBe(200);
    expect(doc.metadata?.proxyUsed).toBe("stealth");
    expect(doc.warning).toContain("retried through the stealth proxy");
    expect(doc.warning).toContain("HTTP 403");
    expect(basic.requests).toHaveLength(1);
    expect(stealth.requests.map((r) => r.url)).toEqual([`${PUBLIC}/blocked`]);
  });

  test("so is a 429", async () => {
    const doc = await engineWith().scrape({ url: `${PUBLIC}/limited` });
    expect(doc.metadata).toMatchObject({ statusCode: 200, proxyUsed: "stealth" });
    expect(doc.warning).toContain("HTTP 429");
  });

  test("other statuses are not: a 404 stays a 404 and the stealth proxy is not asked", async () => {
    const doc = await engineWith().scrape({ url: `${PUBLIC}/gone` });
    expect(doc.metadata).toMatchObject({ statusCode: 404, proxyUsed: "basic" });
    expect(doc.warning).toBeUndefined();
    expect(stealth.requests).toEqual([]);
  });

  test("a page that was not blocked does not touch the stealth proxy", async () => {
    const doc = await engineWith().scrape({ url: `${PUBLIC}/ok` });
    expect(doc.metadata?.proxyUsed).toBe("basic");
    expect(stealth.requests).toEqual([]);
  });

  test("without SEX_STEALTH_PROXY_URL the 403 comes back as it did before", async () => {
    const doc = await engineWith({ stealthProxyUrl: undefined }).scrape({ url: `${PUBLIC}/blocked` });
    expect(doc.metadata).toMatchObject({ statusCode: 403, proxyUsed: "basic" });
    expect(doc.markdown).toContain("blocked by the wall");
    expect(doc.warning).toBeUndefined();
    expect(stealth.requests).toEqual([]);
  });

  test('proxy: "basic" is never retried', async () => {
    const doc = await engineWith().scrape({ url: `${PUBLIC}/blocked`, proxy: "basic" });
    expect(doc.metadata).toMatchObject({ statusCode: 403, proxyUsed: "basic" });
    expect(stealth.requests).toEqual([]);
  });

  test.each(["auto", "enhanced"] as const)('proxy: "%s" is retried like no proxy option', async (proxy) => {
    const doc = await engineWith().scrape({ url: `${PUBLIC}/blocked`, proxy });
    expect(doc.metadata?.proxyUsed).toBe("stealth");
    // "enhanced" is still not a tier this server has.
    expect(doc.warning?.includes('proxy "enhanced" is not available')).toBe(proxy === "enhanced");
  });

  test('proxy: "stealth" goes straight to the stealth proxy, without a warning that it is unavailable', async () => {
    const doc = await engineWith().scrape({ url: `${PUBLIC}/blocked`, proxy: "stealth" });
    expect(doc.metadata).toMatchObject({ statusCode: 200, proxyUsed: "stealth" });
    expect(doc.warning).toBeUndefined();
    expect(basic.requests).toEqual([]);
    expect(stealth.requests).toHaveLength(1);
  });

  test('proxy: "stealth" without a stealth proxy is the old warning and a direct (here: basic proxy) fetch', async () => {
    const doc = await engineWith({ stealthProxyUrl: undefined }).scrape({ url: `${PUBLIC}/ok`, proxy: "stealth" });
    expect(doc.warning).toContain('proxy "stealth" is not available');
    expect(doc.metadata?.proxyUsed).toBe("basic");
  });

  test('proxy: "stealth" with actions is refused instead of dropping the actions', async () => {
    await expect(
      engineWith().scrape({ url: `${PUBLIC}/ok`, proxy: "stealth", actions: [{ type: "wait", milliseconds: 1 }] }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  test("a stealth answer that is blocked too is returned as it is, from the stealth proxy", async () => {
    const doc = await engineWith().scrape({ url: `${PUBLIC}/still-blocked` });
    // The basic proxy's wall answers 403 for this path as well; the page now comes from the stealth proxy.
    expect(doc.metadata).toMatchObject({ statusCode: 403, proxyUsed: "stealth" });
    expect(doc.markdown).toContain("blocked again");
    expect(stealth.requests).toHaveLength(1);
  });

  test("a stealth proxy that is down leaves the first answer, with a warning", async () => {
    const doc = await engineWith({ stealthProxyUrl: "http://127.0.0.1:1" }).scrape({ url: `${PUBLIC}/blocked` });
    expect(doc.metadata).toMatchObject({ statusCode: 403, proxyUsed: "basic" });
    expect(doc.markdown).toContain("blocked by the wall");
    expect(doc.warning).toContain("the retry through the stealth proxy failed");
    expect(doc.warning).not.toContain("127.0.0.1:1");
  });

  test("the same proxy twice is not a retry", async () => {
    const doc = await engineWith({ stealthProxyUrl: basic.url }).scrape({ url: `${PUBLIC}/blocked` });
    expect(doc.metadata?.statusCode).toBe(403);
    expect(basic.requests).toHaveLength(1);
  });

  describe("a dropped connection", () => {
    let resetter: Server;
    let resets = 0;
    beforeAll(async () => {
      // A "proxy" that resets every connection, as a bot wall does.
      resetter = createServer((socket) => {
        resets++;
        socket.on("error", () => {});
        socket.destroy();
      });
      await new Promise<void>((r) => resetter.listen(0, "127.0.0.1", r));
    });
    afterAll(() => resetter.close());
    const resetUrl = () => `http://127.0.0.1:${(resetter.address() as { port: number }).port}`;

    test("SCRAPE_SITE_ERROR is retried through the stealth proxy", async () => {
      const before = resets;
      const doc = await engineWith({ proxyUrl: resetUrl() }).scrape({ url: `${PUBLIC}/blocked` });
      expect(resets).toBeGreaterThan(before);
      expect(doc.metadata).toMatchObject({ statusCode: 200, proxyUsed: "stealth" });
      expect(doc.warning).toContain("SCRAPE_SITE_ERROR");
    });

    test("and is the error reported if the stealth proxy fails as well", async () => {
      await expect(
        engineWith({ proxyUrl: resetUrl(), stealthProxyUrl: resetUrl() }).scrape({ url: `${PUBLIC}/blocked` }),
      ).rejects.toMatchObject({
        code: "SCRAPE_SITE_ERROR",
      });
    });
  });

  describe("SSRF rules are those of SEX_PROXY_URL", () => {
    test("a private address is refused, and a refusal is not a block to retry", async () => {
      await expect(engineWith().scrape({ url: "http://127.0.0.1/" })).rejects.toMatchObject({ code: "PRIVATE_NETWORK_BLOCKED" });
      expect(basic.requests).toEqual([]);
      expect(stealth.requests).toEqual([]);
    });

    test("a name that does not resolve here is refused before the stealth proxy could resolve it", async () => {
      await expect(engineWith().scrape({ url: "http://no-such-host.invalid/", proxy: "stealth" })).rejects.toMatchObject({
        code: "SCRAPE_DNS_RESOLUTION_ERROR",
      });
      expect(stealth.requests).toEqual([]);
    });

    test("every hop through the stealth proxy is checked: a redirect to a private address is not followed", async () => {
      await expect(engineWith().scrape({ url: `${PUBLIC}/to-private`, proxy: "stealth" })).rejects.toMatchObject({
        code: "PRIVATE_NETWORK_BLOCKED",
      });
      expect(stealth.requests.map((r) => r.url)).toEqual([`${PUBLIC}/to-private`]);
    });

    test("a Proxy-Authorization header from the caller does not reach the stealth proxy", async () => {
      await engineWith().scrape({ url: `${PUBLIC}/blocked`, headers: { "Proxy-Authorization": "Basic Y2FsbGVy" } });
      expect(stealth.requests[0]?.headers.get("proxy-authorization")).toBeNull();
    });
  });

  describe("deadline", () => {
    test("a stealth proxy that hangs ends the scrape at its timeout, not later", async () => {
      const hang = createServer((socket) => socket.on("error", () => {}));
      await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
      try {
        const engine = engineWith({ stealthProxyUrl: `http://127.0.0.1:${(hang.address() as { port: number }).port}` });
        const started = performance.now();
        await expect(engine.scrape({ url: `${PUBLIC}/blocked`, timeout: 3_000 })).rejects.toMatchObject({ code: "SCRAPE_TIMEOUT" });
        expect(performance.now() - started).toBeLessThan(4_500);
      } finally {
        hang.close();
      }
    });

    test("with too little time left there is no retry", async () => {
      // The basic proxy takes 1.5 s of a 3 s scrape: under the 2 s a retry needs.
      const lagging = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch() {
          await Bun.sleep(1_500);
          return new Response(page("slow wall"), { status: 403, headers: html });
        },
      });
      const lagProxy = await startCountingProxy((u) => new URL(`${u.pathname}${u.search}`, `http://127.0.0.1:${lagging.port}`));
      try {
        const doc = await engineWith({ proxyUrl: lagProxy.url }).scrape({ url: `${PUBLIC}/blocked`, timeout: 3_000 });
        expect(doc.metadata?.statusCode).toBe(403);
        expect(stealth.requests).toEqual([]);
      } finally {
        lagProxy.close();
        lagging.stop(true);
      }
    });
  });

  describe("with a browser", () => {
    const extracted = (markdown: string) => ({
      metadata: {},
      attributes: [],
      html: "",
      markdown,
      notes: [],
      defuddle: { title: "", description: "", author: "", published: "", site: "", image: "", language: "", wordCount: 0 },
    });
    const blockedBrowser = (status: number): ScrapeBrowser & { calls: number } => {
      const browser = {
        enabled: true,
        calls: 0,
        scrape: async (): Promise<BrowserScrapeResult> => {
          browser.calls++;
          return {
            url: `${PUBLIC}/blocked`,
            status,
            contentType: "text/html",
            rawHtml: "<html></html>",
            extracted: extracted("# browser wall"),
          };
        },
      };
      return browser;
    };
    const ctx = (engine: BaseEngine, browser: ScrapeBrowser): ScrapeContext => ({
      settings: engine.settings,
      scrapeLimit: engine.scrapeLimit,
      extractPool: engine.extractPool,
      browser,
    });

    test("a blocked browser page is fetched over HTTP through the stealth proxy, and replaced by it", async () => {
      const browser = blockedBrowser(403);
      const { document } = await scrapeUrl(ctx(engineWith(), browser), `${PUBLIC}/blocked`);
      expect(browser.calls).toBe(1);
      expect(document.markdown).toContain("real content");
      expect(document.metadata).toMatchObject({ statusCode: 200, proxyUsed: "stealth" });
      expect(document.warning).toContain("The browser was blocked by the site (HTTP 403)");
      expect(basic.requests).toEqual([]);
    });

    test("if that is blocked too, the browser's page stays", async () => {
      const browser = blockedBrowser(429);
      const { document } = await scrapeUrl(ctx(engineWith(), browser), `${PUBLIC}/still-blocked`);
      expect(document.markdown).toContain("browser wall");
      expect(document.metadata).toMatchObject({ statusCode: 429, proxyUsed: "basic" });
      expect(document.warning).toContain("was blocked too");
    });

    test("actions are never replayed over HTTP", async () => {
      const browser = blockedBrowser(403);
      const { document } = await scrapeUrl(ctx(engineWith(), browser), `${PUBLIC}/blocked`, {
        actions: [{ type: "wait", milliseconds: 1 }],
      });
      expect(document.markdown).toContain("browser wall");
      expect(stealth.requests).toEqual([]);
    });

    test('proxy: "stealth" does not render in the browser', async () => {
      const browser = blockedBrowser(200);
      const { document } = await scrapeUrl(ctx(engineWith(), browser), `${PUBLIC}/blocked`, { proxy: "stealth" });
      expect(browser.calls).toBe(0);
      expect(document.metadata?.proxyUsed).toBe("stealth");
      expect(document.warning).toContain("so scripts did not run");
    });
  });
});

describe("SEX_STEALTH_PROXY_URL config", () => {
  test("is read from the environment and unset by default", () => {
    expect(resolveCoreConfig({}, undefined, {}).stealthProxyUrl).toBeUndefined();
    expect(resolveCoreConfig({}, undefined, { SEX_STEALTH_PROXY_URL: " " }).stealthProxyUrl).toBeUndefined();
    expect(resolveCoreConfig({}, undefined, { SEX_STEALTH_PROXY_URL: "http://p:3128" }).stealthProxyUrl).toBe("http://p:3128");
  });

  test("an invalid value is CONFIG_INVALID without echoing the credentials", () => {
    let err: Error | undefined;
    try {
      resolveCoreConfig({}, undefined, { SEX_STEALTH_PROXY_URL: "socks5://user:secret@proxy:1080" });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain("SEX_STEALTH_PROXY_URL");
    expect(err?.message).not.toContain("secret");
  });
});
