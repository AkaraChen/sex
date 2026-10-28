import { afterAll, describe, expect, test } from "bun:test";
import { Deadline } from "../src/deadline.ts";
import { ExtractPool } from "../src/extract-pool.ts";
import type { PageExtractOptions } from "../src/page.ts";
import { testCoreEngine } from "./helpers.ts";

/** Page of `count` paragraphs (~300 bytes each); the needle sits in the first one so extraction output can be checked. */
const pageOf = (count: number) => {
  const paras: string[] = [];
  for (let i = 0; i < count; i++) paras.push(`<p>Paragraph ${i} about extraction. ${"Lorem ipsum dolor sit amet. ".repeat(10)}</p>`);
  paras[0] = "<p>Needle text for the big page.</p>";
  return `<!doctype html><html lang="en"><head><title>Big</title></head><body><main><article><h1>Big</h1>${paras.join("")}</article></main></body></html>`;
};
/** ~1.5 MB. */
const bigHtml = pageOf(5000);
/** ~6 MB: parsing this takes well over the 1 s timeout used below. */
const hugeHtml = pageOf(20_000);

const smallHtml = `<!doctype html><html lang="en"><head><title>Small</title></head><body><main><article><h1>Small</h1><p>Hello from the small page.</p></article></main></body></html>`;

const opts = (url: string): PageExtractOptions => ({
  url,
  onlyMainContent: true,
  removeBase64Images: true,
  wantLinks: false,
  wantImages: false,
  attributes: [],
});

const pools: ExtractPool[] = [];
const newPool = (size: number, timeoutMs: number) => {
  const pool = new ExtractPool(size, timeoutMs);
  pools.push(pool);
  return pool;
};

const engines: Array<{ close(): Promise<void> }> = [];

afterAll(async () => {
  for (const pool of pools) await pool.close();
  for (const engine of engines) await engine.close();
});

describe("extraction pool", () => {
  test("event loop stays responsive while a large page is scraped", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(bigHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    const engine = testCoreEngine();
    engines.push(engine);
    try {
      let last = performance.now();
      let maxGap = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
      }, 10);
      const doc = await engine.scrape({ url: `http://127.0.0.1:${server.port}/big` });
      clearInterval(timer);
      expect(doc.markdown ?? "").toContain("Needle text for the big page.");
      expect(maxGap).toBeLessThan(150);
    } finally {
      server.stop(true);
    }
  });

  test("inline mode (size 0) matches worker mode", async () => {
    const url = "https://example.test/small";
    const inline = await newPool(0, 10_000).html(smallHtml, opts(url), Deadline.unbounded());
    const worker = await newPool(1, 10_000).html(smallHtml, opts(url), Deadline.unbounded());
    expect(inline.markdown).toContain("Hello from the small page.");
    expect(worker.markdown).toBe(inline.markdown);
    expect(worker.defuddle.title).toBe(inline.defuddle.title);
  });

  // The timer covers worker startup too (a fresh worker needs ~150 ms before it answers), so 50 ms cannot
  // succeed for the recovery call; use 1 s with a page far larger than that.
  test("a timed-out job rejects with EXTRACT_TIMEOUT and the pool recovers", async () => {
    const pool = newPool(1, 1000);
    const err = await pool.html(hugeHtml, opts("https://example.test/big"), Deadline.unbounded()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "EXTRACT_TIMEOUT", status: 422 });

    const after = await pool.html(smallHtml, opts("https://example.test/small"), Deadline.unbounded());
    expect(after.markdown).toContain("Hello from the small page.");
  });

  test("the deadline stops a running job and the pool recovers", async () => {
    const pool = newPool(1, 60_000);
    const t0 = performance.now();
    const err = await pool.html(hugeHtml, opts("https://example.test/big"), Deadline.start(300)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "SCRAPE_TIMEOUT", status: 408 });
    expect(performance.now() - t0).toBeLessThan(1500);

    const after = await pool.html(smallHtml, opts("https://example.test/small"), Deadline.unbounded());
    expect(after.markdown).toContain("Hello from the small page.");
  });

  test("a job still waiting in the queue leaves it when the deadline ends, without disturbing the one running", async () => {
    const pool = newPool(1, 60_000);
    const running = pool.html(bigHtml, opts("https://example.test/big"), Deadline.unbounded());
    const err = await pool.html(smallHtml, opts("https://example.test/small"), Deadline.start(20)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "SCRAPE_TIMEOUT" });
    expect((await running).markdown).toContain("Needle text for the big page.");
  });

  test("a cancelled caller is TIMEOUT and stops the worker", async () => {
    const caller = new AbortController();
    const run = newPool(1, 60_000).html(hugeHtml, opts("https://example.test/big"), Deadline.unbounded(caller.signal));
    setTimeout(() => caller.abort(), 30);
    expect(
      await run.then(
        () => undefined,
        (e: unknown) => e,
      ),
    ).toMatchObject({ code: "TIMEOUT", status: 408 });
  });
});
