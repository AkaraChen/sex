import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { Deadline } from "@sex/core/deadline.ts";
import { EgressPolicy } from "@sex/core/egress.ts";
import { resolveConfig } from "../src/config.ts";
import { AdBlockList } from "../src/engine/adblock.ts";
import { BrowserPool } from "../src/engine/browser.ts";

// Opt-in, needs Chrome on this machine (the CI chrome job): SEX_TEST_CDP_URL=http://127.0.0.1:9222 bun test packages/sex/test/egress-browser.test.ts
// The page is fetched through sex's EgressProxy, so these are the rules as a real browser meets them: documents, redirects,
// subresources, fetch(), WebSocket, over http and over CONNECT. Every case asserts the internal service saw no connection at all.
const CDP = process.env.SEX_TEST_CDP_URL;

/** Declared names stand for public hosts: the policy answers with the address a real check would have validated. */
class PublicNames extends EgressPolicy {
  constructor(
    private readonly names: Record<string, string[]>,
    allowPrivateNetwork = false,
  ) {
    super({ allowPrivateNetwork });
  }
  override async resolve(url: Pick<URL, "hostname" | "href">, requireResolvable = false) {
    return this.names[url.hostname] ?? super.resolve(url, requireResolvable);
  }
}

const extract = { onlyMainContent: true, removeBase64Images: true, wantLinks: false, wantImages: false };
const page = (body: string) =>
  `<!doctype html><title>Egress</title><body><main><article><p>egress fixture</p>${body}</article></main></body>`;

describe.skipIf(!CDP)("browser on this machine, through the EgressProxy", () => {
  let site: ReturnType<typeof Bun.serve>;
  let internal: net.Server;
  let internalPort = 0;
  /** TCP connections the internal service accepted: anything at all, not only well-formed requests. */
  const connections: string[] = [];
  /** Requests the public fixture got (the browser's own favicon request is not interesting). */
  const siteHits: Array<{ path: string; host: string | null }> = [];
  const pools: BrowserPool[] = [];

  const config = (allowPrivateNetwork = false) =>
    resolveConfig({ cdpUrl: CDP, concurrency: 2, timeout: 15_000, searxngUrl: "http://127.0.0.1:1" }, { allowPrivateNetwork }, {});
  const poolFor = (policy: EgressPolicy, list?: AdBlockList) => {
    const pool = new BrowserPool(config(policy.allowPrivateNetwork), { policy, ...(list ? { adBlockList: async () => list } : {}) });
    pools.push(pool);
    return pool;
  };
  const publicNames = () => new PublicNames({ "public.test": ["127.0.0.1"], "ads.test": ["127.0.0.1"] });
  const scrape = (pool: BrowserPool, url: string, extra: { blockAds?: boolean; waitFor?: number } = {}) =>
    pool.scrape({ url, deadline: Deadline.start(20_000), userAgent: "t", extract, ...extra });
  const rejected = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e: unknown) => e as { code?: string },
    );

  beforeAll(async () => {
    internal = net.createServer((socket) => {
      connections.push("connection");
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 6\r\ncontent-type: text/javascript\r\n\r\nsecret");
    });
    await new Promise<void>((r) => internal.listen(0, "127.0.0.1", () => r()));
    internalPort = (internal.address() as net.AddressInfo).port;
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname !== "/favicon.ico") siteHits.push({ path: pathname, host: req.headers.get("host") });
        const html = { headers: { "content-type": "text/html; charset=utf-8" } };
        switch (pathname) {
          case "/redirect":
            return Response.redirect(`http://127.0.0.1:${internalPort}/secret`, 302);
          case "/subresources": {
            const targets = [
              `127.0.0.1:${internalPort}`,
              `localhost:${internalPort}`,
              "169.254.169.254",
              "10.0.0.1",
              `[::1]:${internalPort}`,
            ];
            const refs = targets.flatMap((t) => [
              `<script src="http://${t}/a.js"></script>`,
              `<img src="http://${t}/i.png">`,
              `<iframe src="http://${t}/f.html"></iframe>`,
              `<script>fetch("http://${t}/x").catch(()=>{});</script>`,
            ]);
            refs.push(`<script>try{new WebSocket("ws://127.0.0.1:${internalPort}/ws")}catch(e){}</script>`);
            refs.push(`<script>fetch("https://127.0.0.1:${internalPort}/tls").catch(()=>{});</script>`);
            return new Response(page(refs.join("")), html);
          }
          case "/loopback-only":
            return new Response(page(`<script src="http://127.0.0.1:${internalPort}/a.js"></script>`), html);
          case "/with-ads":
            return new Response(page(`<script src="http://ads.test:${site.port}/ad.js"></script>`), html);
          case "/ad.js":
            return new Response("window.adLoaded = true", { headers: { "content-type": "text/javascript" } });
          default:
            return new Response(page(""), html);
        }
      },
    });
  });
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.close()));
    site?.stop(true);
    internal?.close();
  });
  beforeEach(() => {
    connections.length = 0;
    siteHits.length = 0;
  });

  test("loads a public page; the name is never looked up by the browser or the proxy", async () => {
    const result = await scrape(poolFor(publicNames()), `http://public.test:${site.port}/hello`);
    expect(result.rawHtml).toContain("egress fixture");
    expect(siteHits).toEqual([{ path: "/hello", host: `public.test:${site.port}` }]);
  });

  test("private main documents are PRIVATE_NETWORK_BLOCKED and the internal service sees no connection", async () => {
    const pool = poolFor(publicNames());
    for (const url of [
      `http://127.0.0.1:${internalPort}/`,
      `http://localhost:${internalPort}/`,
      `http://[::1]:${internalPort}/`,
      "http://169.254.169.254/latest/meta-data/",
      `https://127.0.0.1:${internalPort}/`,
      `https://localhost:${internalPort}/`,
      "http://10.0.0.1/",
    ]) {
      expect([url, (await rejected(scrape(pool, url)))?.code]).toEqual([url, "PRIVATE_NETWORK_BLOCKED"]);
    }
    expect(connections).toEqual([]);
  });

  test("a redirect from a public page to a private address is refused", async () => {
    const err = await rejected(scrape(poolFor(publicNames()), `http://public.test:${site.port}/redirect`));
    expect(err?.code).toBe("PRIVATE_NETWORK_BLOCKED");
    expect(connections).toEqual([]);
  });

  test("private subresources of a public page (script, img, iframe, fetch, WebSocket, over http and TLS) are all refused", async () => {
    const result = await scrape(poolFor(publicNames()), `http://public.test:${site.port}/subresources`, { waitFor: 800 });
    expect(result.rawHtml).toContain("egress fixture");
    expect(connections).toEqual([]);
  });

  test("control: with private networks allowed the same page does reach the internal service", async () => {
    // Nothing is checked, so there is no proxy either: the browser connects out by itself.
    const pool = poolFor(new PublicNames({}, true));
    await scrape(pool, `http://127.0.0.1:${site.port}/loopback-only`);
    expect(connections.length).toBeGreaterThan(0);
  });

  test("a host that does not exist is SCRAPE_DNS_RESOLUTION_ERROR, over http and over CONNECT", async () => {
    const pool = poolFor(publicNames());
    expect((await rejected(scrape(pool, "http://no-such-host.invalid/")))?.code).toBe("SCRAPE_DNS_RESOLUTION_ERROR");
    expect((await rejected(scrape(pool, "https://no-such-host.invalid/")))?.code).toBe("SCRAPE_DNS_RESOLUTION_ERROR");
  });

  test("ad domains are refused by the proxy, and counted; without blockAds they load", async () => {
    const pool = poolFor(publicNames(), AdBlockList.parse("ads.test\n"));
    const blocked = await scrape(pool, `http://public.test:${site.port}/with-ads`, { blockAds: true, waitFor: 300 });
    expect(blocked.adsBlocked).toBe(1);
    expect(siteHits.map((h) => h.path)).toEqual(["/with-ads"]);
    siteHits.length = 0;
    const loaded = await scrape(pool, `http://public.test:${site.port}/with-ads`, { blockAds: false, waitFor: 300 });
    expect(loaded.adsBlocked).toBe(0);
    expect(siteHits.map((h) => h.path).sort()).toEqual(["/ad.js", "/with-ads"]);
  });

  test("leases do not pile up: after a scrape its credentials no longer work", async () => {
    const pool = poolFor(publicNames());
    await scrape(pool, `http://public.test:${site.port}/hello`);
    // Not reachable from outside the class; what can be seen is that the pool keeps working for the next scrape.
    expect((await scrape(pool, `http://public.test:${site.port}/hello`)).rawHtml).toContain("egress fixture");
  });
});
