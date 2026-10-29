import { afterAll, expect, test } from "bun:test";
import { testCoreEngine } from "./helpers.ts";

/** ~1.5 MB page of 5000 paragraphs; the needle sits in the first one. */
const bigHtml = (() => {
  const paras: string[] = [];
  for (let i = 0; i < 5000; i++) paras.push(`<p>Paragraph ${i} about extraction. ${"Lorem ipsum dolor sit amet. ".repeat(10)}</p>`);
  paras[0] = "<p>Needle text for the big page.</p>";
  return `<!doctype html><html lang="en"><head><title>Big</title></head><body><main><article><h1>Big</h1>${paras.join("")}</article></main></body></html>`;
})();

const engines: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  for (const engine of engines) await engine.close();
});

test("event loop stays responsive while a large page is scraped (extraction runs in the worker pool)", async () => {
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
