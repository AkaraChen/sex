import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { ExtractPool, type PageExtractOptions } from "@searxng-js/sex-page";

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
const newPool = (size: number, taskTimeoutMs: number) => {
  const pool = new ExtractPool({ size, taskTimeoutMs });
  pools.push(pool);
  return pool;
};
const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e as { code?: string; status?: number },
  );

after(async () => {
  for (const pool of pools) await pool.close();
});

describe("extraction pool", () => {
  test("inline mode (size 0) matches worker mode", async () => {
    const url = "https://example.test/small";
    const inline = await newPool(0, 10_000).html(smallHtml, opts(url));
    const worker = await newPool(1, 10_000).html(smallHtml, opts(url));
    assert.match(inline.markdown, /Hello from the small page\./);
    assert.equal(worker.markdown, inline.markdown);
    assert.equal(worker.defuddle.title, inline.defuddle.title);
  });

  test("a PDF goes through a worker too", async () => {
    const { textPdf } = await import("./pdf-fixtures.ts");
    const pdf = await newPool(1, 10_000).pdf(textPdf(2));
    assert.deepEqual(
      pdf.pages.map((p) => p.markdown),
      ["Text page 1", "Text page 2"],
    );
  });

  // The timer covers worker startup too (a fresh worker needs ~150 ms before it answers), so 50 ms cannot
  // succeed for the recovery call; use 1 s with a page far larger than that.
  test("a timed-out job rejects with EXTRACT_TIMEOUT and the pool recovers", async () => {
    const pool = newPool(1, 1000);
    const err = await caught(pool.html(hugeHtml, opts("https://example.test/big")));
    assert.equal(err?.code, "EXTRACT_TIMEOUT");
    assert.equal(err?.status, 422);

    const after = await pool.html(smallHtml, opts("https://example.test/small"));
    assert.match(after.markdown, /Hello from the small page\./);
  });

  test("the signal's timeout stops a running job and the pool recovers", async () => {
    const pool = newPool(1, 60_000);
    const t0 = performance.now();
    const err = await caught(pool.html(hugeHtml, opts("https://example.test/big"), AbortSignal.timeout(300)));
    assert.equal(err?.code, "SCRAPE_TIMEOUT");
    assert.equal(err?.status, 408);
    assert.ok(performance.now() - t0 < 1500);

    const after = await pool.html(smallHtml, opts("https://example.test/small"));
    assert.match(after.markdown, /Hello from the small page\./);
  });

  test("a job still waiting in the queue leaves it when the signal aborts, without disturbing the one running", async () => {
    const pool = newPool(1, 60_000);
    const running = pool.html(bigHtml, opts("https://example.test/big"));
    const err = await caught(pool.html(smallHtml, opts("https://example.test/small"), AbortSignal.timeout(20)));
    assert.equal(err?.code, "SCRAPE_TIMEOUT");
    assert.match((await running).markdown, /Needle text for the big page\./);
  });

  test("a cancelled caller is TIMEOUT and stops the worker", async () => {
    const caller = new AbortController();
    const run = newPool(1, 60_000).html(hugeHtml, opts("https://example.test/big"), caller.signal);
    setTimeout(() => caller.abort(), 30);
    const err = await caught(run);
    assert.equal(err?.code, "TIMEOUT");
    assert.equal(err?.status, 408);
  });

  test("an already aborted signal rejects at once", async () => {
    const err = await caught(newPool(1, 1000).html(smallHtml, opts("https://example.test/"), AbortSignal.abort()));
    assert.equal(err?.code, "TIMEOUT");
  });
});
