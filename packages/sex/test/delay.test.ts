// Crawl politeness delay: pages run one at a time, each starting `delay` after the previous one finished.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/engine/engine.ts";
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

describe("crawl delay", () => {
  let hits: Array<{ path: string; at: number; end: number }>;
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
        const hit = { path: pathname, at: Date.now(), end: 0 };
        hits.push(hit);
        // Slow discovery for the start page; the others take a moment too, so a page overlapping the next would show.
        await Bun.sleep(pathname === "/" ? 600 : 120);
        hit.end = Date.now();
        return html(pathname === "/" ? linksPage : leafPage(pathname.slice(1)));
      },
    });
    engine = testEngine();
  });

  afterAll(async () => {
    await engine.close();
    site.stop(true);
  });

  test("each page starts a delay after the previous one finished", async () => {
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
    expect(pages[0]!.at - ordered[0]!.end).toBeGreaterThanOrEqual(450);
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i]!.at - pages[i - 1]!.end).toBeGreaterThanOrEqual(450);
    }
  }, 15_000);
});
