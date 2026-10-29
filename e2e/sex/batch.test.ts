// Batch scrape over HTTP, including the SSRF rules for submitted URLs (behind a proxy that maps a public IP to a local site).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startCountingProxy } from "@searxng-js/sex-testing";
import { api, killAll, type Server } from "../lib/proc.ts";
import { html, prose, type Site, site } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { readAllDocs, sourceUrls, startSex, waitJob } from "./helpers.ts";
import { paths, type TreeSite, treeSite } from "./tree-site.ts";

let srv: Server;
let strict: Server;
let pages: Site;
let slow: TreeSite;
let proxy: Awaited<ReturnType<typeof startCountingProxy>>;

beforeAll(async () => {
  pages = site((_req, url) => {
    if (url.pathname === "/missing") return new Response("gone", { status: 404 });
    return html(`Page ${url.pathname}`, `<h1>Page ${url.pathname}</h1>${prose(url.pathname, 2)}<a href="/other">other</a>`);
  });
  slow = treeSite({ delayMs: 300 });
  proxy = await startCountingProxy((u) => new URL(u.pathname + u.search, pages.url));
  srv = await startSex();
  strict = await startSex([], { privateNetwork: false, env: { SEX_PROXY_URL: proxy.url } });
});

afterAll(async () => {
  pages.stop();
  slow.stop();
  proxy.close();
  await killAll();
  removeTempDirs();
});

describe("batch scrape", () => {
  test("scrapes every URL with the shared options and reports a status", async () => {
    const urls = ["/a", "/b", "/c"].map((p) => `${pages.url}${p}`);
    const created = await api(srv.url, "/v2/batch/scrape", { body: { urls, formats: ["markdown", "links"] } });
    expect(created.status).toBe(200);
    expect(created.body.success).toBe(true);
    expect(created.body.url).toBe(`${srv.url}/v2/batch/scrape/${created.body.id}`);
    expect(created.body.invalidURLs).toBeUndefined();
    const status = await waitJob(srv, `/v2/batch/scrape/${created.body.id}`);
    expect(status).toMatchObject({ status: "completed", total: 3, completed: 3, creditsUsed: 3, next: null });
    expect(status.data).toHaveLength(3);
    expect(paths(sourceUrls(status.data), pages.url)).toEqual(["/a", "/b", "/c"]);
    for (const d of status.data) {
      expect(d.markdown).toContain("Page ");
      expect(d.links).toEqual([`${pages.url}/other`]);
    }
  });

  test("invalid URLs are skipped and listed; a 404 page is still a document; a refused connection is an error", async () => {
    const created = await api(srv.url, "/v2/batch/scrape", {
      body: { urls: [`${pages.url}/ok`, "not a url", `${pages.url}/missing`, "http://127.0.0.1:1/"], formats: ["markdown"] },
    });
    expect(created.status).toBe(200);
    expect(created.body.invalidURLs).toEqual(["not a url"]);
    const path = `/v2/batch/scrape/${created.body.id}`;
    const status = await waitJob(srv, path);
    expect(status.status).toBe("completed");
    // Failed pages are in neither total nor completed (they are only in /errors).
    expect(status.total).toBe(2);
    expect(status.completed).toBe(2);
    const missing = status.data.find((d: any) => d.metadata.sourceURL.endsWith("/missing"));
    expect(missing.metadata.statusCode).toBe(404);

    const errors = await api(srv.url, `${path}/errors`);
    expect(errors.status).toBe(200);
    expect(errors.body.errors).toHaveLength(1);
    expect(errors.body.errors[0]).toMatchObject({ url: "http://127.0.0.1:1/", code: "SCRAPE_SITE_ERROR" });
    expect(errors.body.errors[0].id).toBeTruthy();
    expect(errors.body.errors[0].timestamp).toBeTruthy();
    expect(errors.body.errors[0].error).toBeTruthy();
    expect(errors.body.robotsBlocked).toEqual([]);
  });

  test("ignoreInvalidURLs: false and all-invalid lists are 400", async () => {
    const strictList = await api(srv.url, "/v2/batch/scrape", { body: { urls: [`${pages.url}/ok`, "nope"], ignoreInvalidURLs: false } });
    expect(strictList.status).toBe(400);
    const none = await api(srv.url, "/v2/batch/scrape", { body: { urls: ["nope", "also nope"] } });
    expect(none.status).toBe(400);
    expect(none.body.details.invalidURLs).toEqual(["nope", "also nope"]);
    const empty = await api(srv.url, "/v2/batch/scrape", { body: { urls: [] } });
    expect(empty.status).toBe(400);
  });

  test("the status route pages with limit and next, each document once", async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `${pages.url}/p${i}`);
    const created = await api(srv.url, "/v2/batch/scrape", { body: { urls, formats: ["markdown"] } });
    const path = `/v2/batch/scrape/${created.body.id}`;
    await waitJob(srv, path);
    const { docs, pages: n } = await readAllDocs(srv, path, 5);
    expect(n).toBe(3);
    expect(sourceUrls(docs).sort()).toEqual([...urls].sort());
  });

  test("maxConcurrency caps the pages in flight", async () => {
    slow.resetStats();
    const urls = Array.from({ length: 8 }, (_, i) => `${slow.url}/wide/${i}`);
    const created = await api(srv.url, "/v2/batch/scrape", { body: { urls, maxConcurrency: 2 } });
    const status = await waitJob(srv, `/v2/batch/scrape/${created.body.id}`);
    expect(status.completed).toBe(8);
    expect(slow.peak()).toBe(2);
  }, 60_000);

  test("DELETE cancels a batch", async () => {
    slow.resetStats();
    const urls = Array.from({ length: 20 }, (_, i) => `${slow.url}/wide/${i}`);
    const created = await api(srv.url, "/v2/batch/scrape", { body: { urls, maxConcurrency: 1 } });
    const path = `/v2/batch/scrape/${created.body.id}`;
    await Bun.sleep(1000);
    const cancelled = await api(srv.url, path, { method: "DELETE" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    await Bun.sleep(700);
    const settled = slow.starts.length;
    await Bun.sleep(1200);
    expect(slow.starts.length).toBe(settled);
    expect(settled).toBeLessThan(20);
    const status = await api(srv.url, path);
    expect(status.body.status).toBe("cancelled");
  }, 60_000);

  test("unknown ids are 404", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect((await api(srv.url, `/v2/batch/scrape/${id}`)).status).toBe(404);
    expect((await api(srv.url, `/v2/batch/scrape/${id}/errors`)).status).toBe(404);
    expect((await api(srv.url, `/v2/batch/scrape/${id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("private addresses in submitted URLs", () => {
  test("loopback, link-local (metadata) and localhost are invalid; public addresses go through the proxy", async () => {
    const created = await api(strict.url, "/v2/batch/scrape", {
      body: {
        urls: [
          "http://93.184.216.34/one",
          "http://93.184.216.34/two",
          `${pages.url}/private`,
          "http://169.254.169.254/latest/meta-data",
          "http://localhost/x",
          "not a url",
        ],
        formats: ["markdown"],
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.invalidURLs.sort()).toEqual(
      ["http://169.254.169.254/latest/meta-data", "http://localhost/x", `${pages.url}/private`, "not a url"].sort(),
    );
    const status = await waitJob(strict, `/v2/batch/scrape/${created.body.id}`);
    expect(status.completed).toBe(2);
    expect(status.data.map((d: any) => d.markdown).join("\n")).toContain("Page /one");
    expect(proxy.requests.map((r) => r.url)).not.toContain("http://169.254.169.254/latest/meta-data");
  });

  test("only private URLs is a 400, and a single scrape says PRIVATE_NETWORK_BLOCKED", async () => {
    const batch = await api(strict.url, "/v2/batch/scrape", { body: { urls: [`${pages.url}/private`] } });
    expect(batch.status).toBe(400);
    const single = await api(strict.url, "/v2/scrape", { body: { url: `${pages.url}/private` } });
    expect(single.status).toBe(403);
    expect(single.body.code).toBe("PRIVATE_NETWORK_BLOCKED");
  });

  test("a crawl cannot reach a private start URL either", async () => {
    const r = await api(strict.url, "/v2/crawl", { body: { url: `${pages.url}/` } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("PRIVATE_NETWORK_BLOCKED");
  });
});
