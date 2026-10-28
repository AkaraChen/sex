import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DocsResult, ScrapeDocs } from "../src/capabilities.ts";
import { type ScrapeContext, scrapeUrl } from "../src/scrape.ts";
import { testCoreEngine } from "./helpers.ts";

describe("partial document conversions", () => {
  const engine = testCoreEngine();
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } }),
    });
  });
  afterAll(async () => {
    server.stop(true);
    await engine.close();
  });

  const scrapeWith = async (result: DocsResult, maxPages?: number) => {
    const docs: ScrapeDocs = { enabled: true, convert: async () => result };
    const ctx: ScrapeContext = { config: engine.config, scrapeLimit: engine.scrapeLimit, extractPool: engine.extractPool, docs };
    const parsers = maxPages === undefined ? undefined : [{ type: "pdf" as const, maxPages }];
    return (await scrapeUrl(ctx, `http://127.0.0.1:${server.port}/a.pdf`, { parsers })).document.warning;
  };

  test("maxPages stopping the conversion is reported", async () => {
    const warning = await scrapeWith({ markdown: "x", numPages: 10, pagesConverted: 3, warnings: [] }, 3);
    expect(warning).toBe("Converted the first 3 of 10 pages (parsers maxPages)");
  });

  test("a timeout's partial result has only the docs warning", async () => {
    const timeout = { code: "timeout", message: "Timed out: converted only the first 2 of 10 pages" };
    // Without maxPages, and with a maxPages the conversion did not reach.
    expect(await scrapeWith({ markdown: "x", numPages: 10, pagesConverted: 2, warnings: [timeout] })).toBe(timeout.message);
    expect(await scrapeWith({ markdown: "x", numPages: 10, pagesConverted: 2, warnings: [timeout] }, 5)).toBe(timeout.message);
  });

  test("a document shorter than maxPages has no warning", async () => {
    expect(await scrapeWith({ markdown: "x", numPages: 2, pagesConverted: 2, warnings: [] }, 5)).toBeUndefined();
  });
});
