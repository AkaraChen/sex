// Crawl politeness delay: slots are reserved relative to "now", so pages discovered late never burst.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/core/engine.ts";
import { MemoryDocumentLog } from "../src/core/jobs/documents.ts";
import { SqliteJobStore } from "../src/core/jobs/sqlite.ts";
import { testEngine, waitFor } from "./helpers.ts";

const linksPage = `<!doctype html><html lang="en"><head><title>Start</title></head><body><main><article><h1>Start</h1>
<p>Start page content, long enough to be kept by the extractor. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
${[1, 2, 3, 4, 5].map((i) => `<a href="/p${i}">p${i}</a>`).join(" ")}
</article></main></body></html>`;

const leafPage = (n: string) =>
  `<!doctype html><html lang="en"><head><title>${n}</title></head><body><main><article><h1>${n}</h1>
<p>${n} content, long enough to be kept by the extractor. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
</article></main></body></html>`;

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("crawl delay slots", () => {
  let hits: Array<{ path: string; at: number }>;
  let site: ReturnType<typeof Bun.serve>;
  let engine: Engine;

  beforeAll(() => {
    hits = [];
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/robots.txt" || pathname === "/sitemap.xml") return new Response("not found", { status: 404 });
        hits.push({ path: pathname, at: Date.now() });
        if (pathname === "/") {
          // Slow discovery: the links are only known after the nominal slot times have passed.
          await Bun.sleep(1600);
          return html(linksPage);
        }
        return html(leafPage(pathname.slice(1)));
      },
    });
    engine = testEngine();
  });

  afterAll(async () => {
    await engine.close();
    site.stop(true);
  });

  test("page fetches after the start page stay spaced by the delay", async () => {
    const base = `http://127.0.0.1:${site.port}`;
    const job = await engine.crawl({ url: `${base}/`, delay: 0.5, sitemap: "skip", limit: 10 });
    await waitFor(async () => {
      const j = await engine.getJob(job.id, "crawl");
      return j.status === "scraping" ? undefined : j;
    });

    const ordered = [...hits].sort((a, b) => a.at - b.at);
    expect(ordered.map((h) => h.path)).toEqual(["/", "/p1", "/p2", "/p3", "/p4", "/p5"]);
    const pages = ordered.slice(ordered.findIndex((h) => h.path === "/") + 1);
    expect(pages.length).toBe(5);
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i]!.at - pages[i - 1]!.at).toBeGreaterThanOrEqual(450);
    }
  }, 15_000);

  test("reserveSlots hands out non-overlapping slots", async () => {
    const store = new SqliteJobStore(":memory:", 60_000, new MemoryDocumentLog());
    try {
      const job = await store.create({ kind: "crawl", url: "http://example.test/", options: {} });
      expect(await store.reserveSlots(job.id, 3, 100, 1000)).toBe(1000);
      expect(await store.reserveSlots(job.id, 2, 100, 1050)).toBe(1300);
      expect(await store.reserveSlots(job.id, 1, 100, 5000)).toBe(5000);
    } finally {
      await store.close();
    }
  });
});
