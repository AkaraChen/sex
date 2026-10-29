// Link following, sitemaps, robots.txt and webhooks are outbound paths too: a public site (or a caller) that names a private
// address in them must not make sex connect there. Setup as in ssrf.test.ts: the site is at the public IP literal 93.184.216.34,
// delivered by SEX_PROXY_URL to a local fixture; a raw TCP tripwire on 127.0.0.1 / [::1] records any connection at all.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { api, killAll, until } from "../lib/proc.ts";
import { html, prose } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { jobDone, type Listener, PUBLIC_IP, type PublicSite, privateTargets, startListener, startPublicSite, startSex } from "./support.ts";

let tripwire: Listener;
let pub: PublicSite;
const hosts = () => privateTargets(tripwire.port).map((t) => t.host);
const page = (title: string, extra = "") => html(title, `<main><article><h1>${title}</h1>${prose(title)}${extra}</article></main>`);

beforeAll(async () => {
  tripwire = await startListener();
  const privateUrls = () => hosts().map((h) => `http://${h}/secret`);
  pub = await startPublicSite((_req, url) => {
    switch (url.pathname) {
      case "/":
        return page(
          "Root",
          `<a href="/p1">public page</a>${privateUrls()
            .map((u, i) => `<a href="${u}">private ${i}</a>`)
            .join(" ")}<a href="/redirect-private">redirecting link</a>`,
        );
      case "/p1":
        return page("P1");
      case "/redirect-private":
        return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${tripwire.port}/from-redirect` } });
      case "/robots.txt":
        return new Response(
          `User-agent: *\nAllow: /\n${privateUrls()
            .map((u) => `Sitemap: ${u.replace("/secret", "/sitemap.xml")}`)
            .join("\n")}\nSitemap: http://${PUBLIC_IP}/sitemap.xml\nSitemap: http://${PUBLIC_IP}/sitemap-index.xml\n`,
          { headers: { "content-type": "text/plain" } },
        );
      case "/sitemap.xml":
        return new Response(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://${PUBLIC_IP}/p1</loc></url>${privateUrls()
            .map((u) => `<url><loc>${u}</loc></url>`)
            .join("")}</urlset>`,
          { headers: { "content-type": "application/xml" } },
        );
      case "/sitemap-index.xml":
        return new Response(
          `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${hosts()
            .map((h) => `<sitemap><loc>http://${h}/nested.xml</loc></sitemap>`)
            .join("")}</sitemapindex>`,
          { headers: { "content-type": "application/xml" } },
        );
      case "/hook":
        return new Response("ok");
      default:
        return new Response("not found", { status: 404 });
    }
  });
});
beforeEach(() => {
  tripwire.connections.length = 0;
  pub.clear();
});
afterAll(async () => {
  tripwire?.stop();
  pub?.stop();
  await killAll();
  removeTempDirs();
});

const noPrivateRequests = () => {
  expect(tripwire.connections).toEqual([]);
  for (const u of pub.proxied) expect(u.startsWith(`http://${PUBLIC_IP}/`)).toBe(true);
};

describe("crawl and map", () => {
  test("a crawl follows links to public pages only: links to private addresses (even with allowExternalLinks) are not fetched", async () => {
    const s = await startSex([], { SEX_PROXY_URL: pub.proxyUrl });
    const start = await api(s.url, "/v2/crawl", {
      body: { url: `${pub.origin}/`, limit: 50, sitemap: "skip", allowExternalLinks: true, allowSubdomains: true, crawlEntireDomain: true },
    });
    expect(start.status).toBe(200);
    const done = await jobDone(s.url, "crawl", start.body.id as string);
    expect(done.status).toBe("completed");
    const urls = done.data.map((d) => d.metadata.sourceURL).sort();
    expect(urls).toEqual([`${pub.origin}/`, `${pub.origin}/p1`]);
    expect(pub.proxied).toContain(`http://${PUBLIC_IP}/redirect-private`);
    // The page that redirects to a private address was tried (it is a public link) and its redirect refused.
    noPrivateRequests();
    await s.stop();
  }, 90_000);

  test("sitemap entries and robots.txt Sitemap lines at private addresses are never fetched (crawl, sitemap: include)", async () => {
    const s = await startSex([], { SEX_PROXY_URL: pub.proxyUrl });
    const start = await api(s.url, "/v2/crawl", {
      body: { url: `${pub.origin}/`, limit: 50, sitemap: "include", allowExternalLinks: true, crawlEntireDomain: true },
    });
    expect(start.status).toBe(200);
    const done = await jobDone(s.url, "crawl", start.body.id as string);
    expect(done.status).toBe("completed");
    for (const d of done.data) expect(d.metadata.sourceURL.startsWith(pub.origin)).toBe(true);
    // The public sitemap was read (proof the discovery ran).
    expect(pub.proxied).toContain(`http://${PUBLIC_IP}/sitemap.xml`);
    noPrivateRequests();
    await s.stop();
  }, 90_000);

  test("map: sitemap entries, nested sitemaps and robots.txt Sitemap lines at private addresses are never fetched", async () => {
    const s = await startSex([], { SEX_PROXY_URL: pub.proxyUrl });
    const res = await api(s.url, "/v2/map", { body: { url: `${pub.origin}/`, sitemap: "include", limit: 100 } });
    expect(res.status).toBe(200);
    expect(pub.proxied).toContain(`http://${PUBLIC_IP}/sitemap.xml`);
    expect(pub.proxied).toContain(`http://${PUBLIC_IP}/sitemap-index.xml`);
    noPrivateRequests();
    await s.stop();
  }, 90_000);

  test("a private start URL is refused for map and crawl", async () => {
    const s = await startSex([], { SEX_PROXY_URL: pub.proxyUrl });
    for (const host of hosts()) {
      const map = await api(s.url, "/v2/map", { body: { url: `http://${host}/` } });
      expect([host, map.status >= 400]).toEqual([host, true]);
      const crawl = await api(s.url, "/v2/crawl", { body: { url: `http://${host}/`, limit: 5 } });
      if (crawl.status === 200) {
        const done = await jobDone(s.url, "crawl", crawl.body.id as string);
        expect([host, done.data.length]).toEqual([host, 0]);
      }
    }
    noPrivateRequests();
    await s.stop();
  }, 180_000);
});

describe("webhooks", () => {
  test("a webhook to a private address is never delivered (batch scrape; the job itself still completes)", async () => {
    const s = await startSex([], { SEX_PROXY_URL: pub.proxyUrl });
    for (const host of hosts()) {
      const res = await api(s.url, "/v2/batch/scrape", {
        body: { urls: [`${pub.origin}/p1`], webhook: { url: `http://${host}/hook`, events: ["completed", "page", "started"] } },
      });
      // Refused at the door (4xx) or accepted and refused at delivery: both are fine, a connection is not.
      if (res.status === 200) {
        const done = await jobDone(s.url, "batch/scrape", res.body.id as string);
        expect([host, done.status]).toEqual([host, "completed"]);
      } else {
        expect([host, res.status >= 400 && res.status < 500]).toEqual([host, true]);
      }
    }
    // Delivery attempts (and their retries) happen after the job ends: give them time to be wrong.
    await Bun.sleep(3000);
    noPrivateRequests();
    await s.stop();
  }, 180_000);

  test("control: a webhook to a public address is delivered through the proxy, signed when a secret is set", async () => {
    const s = await startSex([], { SEX_PROXY_URL: pub.proxyUrl, SEX_WEBHOOK_SECRET: "e2e-secret" });
    const res = await api(s.url, "/v2/batch/scrape", {
      body: { urls: [`${pub.origin}/p1`], webhook: { url: `${pub.origin}/hook`, events: ["completed"] } },
    });
    expect(res.status).toBe(200);
    await until(() => (pub.site.hits.includes("/hook") ? true : undefined), 30_000, 100);
    expect(pub.proxied).toContain(`http://${PUBLIC_IP}/hook`);
    expect(pub.proxiedRequests.find((r) => r.url.endsWith("/hook"))?.headers.get("x-firecrawl-signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
    await s.stop();
  }, 90_000);
});
