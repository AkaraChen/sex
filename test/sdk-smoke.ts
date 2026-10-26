// Manual smoke test: drives a running `sex serve` server with the official Firecrawl SDK.
// Usage: bun test/sdk-smoke.ts [apiUrl]
import Firecrawl from "@mendable/firecrawl-js";

const apiUrl = process.argv[2] ?? "http://127.0.0.1:3002";
const fc = new Firecrawl({ apiUrl, apiKey: "unused" });

const step = async (name: string, fn: () => Promise<unknown>) => {
  const t = performance.now();
  try {
    const out = await fn();
    console.log(`ok   ${name} (${Math.round(performance.now() - t)}ms)`, JSON.stringify(out).slice(0, 300));
  } catch (err) {
    console.log(`FAIL ${name}:`, err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
};

await step("scrape", async () => {
  const doc = await fc.scrape("https://stephango.com/saw", { formats: ["markdown", "links"] });
  return { title: doc.metadata?.title, md: doc.markdown?.slice(0, 80), links: doc.links?.length };
});
await step("search", async () => {
  const r = await fc.search("bun javascript runtime", { limit: 3 });
  return r.web?.map((w) => ("url" in w ? w.url : undefined));
});
await step("search+scrape", async () => {
  const r = await fc.search("defuddle", { limit: 2, scrapeOptions: { formats: ["markdown"] } });
  return r.web?.map((w) => ({ url: (w as { url?: string }).url, md: ((w as { markdown?: string }).markdown ?? "").length }));
});
await step("map", async () => {
  const r = await fc.map("https://bun.com/docs", { limit: 10, search: "test" });
  return r.links.map((l) => l.url);
});
await step("crawl (waiter)", async () => {
  const job = await fc.crawl("https://stephango.com/", { limit: 5, maxDiscoveryDepth: 1, pollInterval: 1 });
  return { status: job.status, total: job.total, completed: job.completed, urls: job.data.map((d) => d.metadata?.sourceURL) };
});
await step("batch scrape (waiter)", async () => {
  const job = await fc.batchScrape(["https://example.com", "https://stephango.com/saw", "not a url"], {
    options: { formats: ["markdown"] },
    ignoreInvalidURLs: true,
    pollInterval: 1,
  });
  return { status: job.status, completed: job.completed, n: job.data.length };
});
await step("crawl cancel", async () => {
  const { id } = await fc.startCrawl("https://bun.com/docs", { limit: 50 });
  const cancelled = await fc.cancelCrawl(id);
  const status = await fc.getCrawlStatus(id);
  return { cancelled, status: status.status };
});
await step("error mapping", async () => {
  try {
    await fc.scrape("https://example.com", { formats: ["changeTracking"] });
    return "unexpected success";
  } catch (err) {
    return (err as Error).message;
  }
});
