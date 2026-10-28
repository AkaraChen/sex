// Crawl politeness delay: slots are reserved relative to "now", so pages discovered late never burst.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/engine/engine.ts";
import { MemoryDocumentLog } from "../src/engine/jobs/documents.ts";
import { SqliteJobStore } from "../src/engine/jobs/sqlite.ts";
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

  test("schedule hands out non-overlapping run times", async () => {
    const store = new SqliteJobStore(":memory:", 60_000, new MemoryDocumentLog());
    try {
      const job = await store.create({ kind: "crawl", url: "http://example.test/", options: {} });
      const links = (prefix: string, n: number) =>
        Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, url: `http://example.test/${prefix}${i}`, blocked: false }));
      const runAts = async (prefix: string, n: number, now: number) =>
        (await store.schedule(job.id, "owner", links(prefix, n), { limit: 100, depth: 1, intervalMs: 100, now })).map((t) => t.runAt);
      expect(await runAts("a", 3, 1000)).toEqual([1000, 1100, 1200]);
      expect(await runAts("b", 2, 1050)).toEqual([1300, 1400]);
      expect(await runAts("c", 1, 5000)).toEqual([5000]);
    } finally {
      await store.close();
    }
  });
});
