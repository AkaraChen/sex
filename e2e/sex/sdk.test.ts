// The official Firecrawl JS SDK against sex: the calls an integration makes, over local sites; plus apps/sex/test/sdk-smoke.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Firecrawl from "@mendable/firecrawl-js";
import { ROOT } from "../lib/bin.ts";
import { startMockLlm } from "../lib/llm.ts";
import { killAll, type Server } from "../lib/proc.ts";
import { html, prose, type Site, site, startMockSearxng } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { kindOf, llmFlags, startSex, userOf } from "./helpers.ts";
import { type TreeSite, treeSite } from "./tree-site.ts";

let srv: Server;
let fc: Firecrawl;
let tree: TreeSite;
let slow: TreeSite;
let docs: Site;
let searxng: ReturnType<typeof startMockSearxng>;
let llm: ReturnType<typeof startMockLlm>;

beforeAll(async () => {
  tree = treeSite();
  slow = treeSite({ delayMs: 300 });
  docs = site((_req, url) => html(`Doc ${url.pathname}`, `<h1>Doc ${url.pathname}</h1>${prose("documents", 2)}`));
  searxng = startMockSearxng(docs.url);
  llm = startMockLlm((req) => {
    const kind = kindOf(req);
    if (kind === "schema") return JSON.stringify({ type: "object", properties: { heading: { type: "string" } } });
    if (kind === "extract") return JSON.stringify({ heading: /# (Page [^\n]*)/.exec(userOf(req))?.[1] ?? "?" });
    return "{}";
  });
  srv = await startSex([...llmFlags(llm), "--searxng-url", searxng.url]);
  fc = new Firecrawl({ apiUrl: srv.url, apiKey: "unused" });
});

afterAll(async () => {
  tree.stop();
  slow.stop();
  docs.stop();
  searxng.stop();
  llm.stop();
  await killAll();
  removeTempDirs();
});

describe("scrape and search", () => {
  test("scrape returns a Document with the requested formats", async () => {
    const doc = await fc.scrape(`${tree.url}/d1`, { formats: ["markdown", "links", "html"] });
    expect(doc.markdown).toContain("Page /d1");
    expect(doc.links).toEqual([`${tree.url}/d2`]);
    expect(doc.html).toContain("Paragraph 1 about /d1");
    expect(doc.metadata?.statusCode).toBe(200);
    expect(doc.metadata?.sourceURL).toBe(`${tree.url}/d1`);
  });

  test("scrape with LLM formats", async () => {
    const doc = await fc.scrape(`${tree.url}/d1`, {
      formats: [{ type: "json", schema: { type: "object", properties: { heading: { type: "string" } } } }],
    });
    expect(doc.json).toEqual({ heading: "Page /d1" });
  });

  test("scrape errors become exceptions with the server's message", async () => {
    await expect(fc.scrape(`${tree.url}/d1`, { formats: ["branding" as never] })).rejects.toThrow(/not supported/);
    await expect(fc.scrape("http://127.0.0.1:1/")).rejects.toThrow();
  });

  test("search returns web results, with scrapeOptions scraping each", async () => {
    const plain = await fc.search("doc a", { limit: 3 });
    const urls = (plain.web ?? []).map((w) => ("url" in w ? w.url : undefined));
    expect(urls).toEqual(expect.arrayContaining([`${docs.url}/docs/a`, `${docs.url}/docs/b`]));
    const scraped = await fc.search("doc a", { limit: 3, scrapeOptions: { formats: ["markdown"] } });
    const a = (scraped.web ?? []).find((w) => "url" in w && w.url === `${docs.url}/docs/a`) as { markdown?: string } | undefined;
    expect(a?.markdown).toContain("Doc /docs/a");
  });
});

describe("map, crawl, batch", () => {
  test("map", async () => {
    const r = await fc.map(`${tree.url}/`, { limit: 6 });
    expect(r.links).toHaveLength(6);
    expect(r.links[0]?.url).toBe(`${tree.url}/`);
  });

  test("crawl waits for the job and returns every page (auto-paginated)", async () => {
    const job = await fc.crawl(`${tree.url}/`, {
      limit: 20,
      sitemap: "skip",
      ignoreRobotsTxt: true,
      maxDiscoveryDepth: 2,
      pollInterval: 1,
    });
    expect(job.status).toBe("completed");
    expect(job.total).toBe(20);
    expect(job.completed).toBe(20);
    expect(job.data).toHaveLength(20);
    expect(new Set(job.data.map((d) => d.metadata?.sourceURL)).size).toBe(20);
  }, 60_000);

  test("startCrawl, getCrawlStatus with pagination limits, getCrawlErrors and getActiveCrawls", async () => {
    const { id } = await fc.startCrawl(`${tree.url}/`, { limit: 10, sitemap: "skip" });
    const done = await (async () => {
      for (let i = 0; i < 300; i++) {
        const s = await fc.getCrawlStatus(id, { autoPaginate: false });
        if (s.status !== "scraping") return s;
        await Bun.sleep(100);
      }
      throw new Error("crawl did not finish");
    })();
    expect(done.status).toBe("completed");
    const all = await fc.getCrawlStatus(id);
    expect(all.data).toHaveLength(10);
    const capped = await fc.getCrawlStatus(id, { maxResults: 4 });
    expect(capped.data.length).toBeLessThanOrEqual(10);
    const errors = await fc.getCrawlErrors(id);
    expect(errors.errors).toEqual([]);
    expect(Array.isArray(errors.robotsBlocked)).toBe(true);
    const active = await fc.getActiveCrawls();
    expect(active.crawls.map((c) => c.id)).not.toContain(id);
  }, 60_000);

  test("cancelCrawl", async () => {
    const { id } = await fc.startCrawl(`${slow.url}/`, { limit: 50, sitemap: "skip", maxConcurrency: 1 });
    await Bun.sleep(500);
    expect(await fc.cancelCrawl(id)).toBe(true);
    const status = await fc.getCrawlStatus(id);
    expect(status.status).toBe("cancelled");
  }, 30_000);

  test("crawlParamsPreview needs the LLM and returns options", async () => {
    const llmOptions = startMockLlm(() => JSON.stringify({ limit: 7, excludePaths: ["^/wide/"] }));
    const withLlm = await startSex(llmFlags(llmOptions));
    const client = new Firecrawl({ apiUrl: withLlm.url, apiKey: "unused" });
    const preview = await client.crawlParamsPreview(`${tree.url}/`, "at most seven pages, not the wide section");
    expect(JSON.stringify(preview)).toContain("^/wide/");
    await withLlm.stop();
    llmOptions.stop();
  });

  test("batchScrape waits and returns the documents; invalid URLs are ignored", async () => {
    const job = await fc.batchScrape([`${tree.url}/d1`, `${tree.url}/d2`, "not a url"], {
      options: { formats: ["markdown"] },
      ignoreInvalidURLs: true,
      pollInterval: 1,
    });
    expect(job.status).toBe("completed");
    expect(job.completed).toBe(2);
    expect(job.data.map((d) => d.metadata?.sourceURL).sort()).toEqual([`${tree.url}/d1`, `${tree.url}/d2`]);
  }, 30_000);

  test("startBatchScrape, getBatchScrapeStatus, getBatchScrapeErrors and cancelBatchScrape", async () => {
    const started = await fc.startBatchScrape([`${tree.url}/d1`, "http://127.0.0.1:1/"], { options: { formats: ["markdown"] } });
    let status = await fc.getBatchScrapeStatus(started.id);
    for (let i = 0; i < 200 && status.status === "scraping"; i++) {
      await Bun.sleep(100);
      status = await fc.getBatchScrapeStatus(started.id);
    }
    expect(status.status).toBe("completed");
    expect(status.data).toHaveLength(1);
    const errors = await fc.getBatchScrapeErrors(started.id);
    expect(errors.errors).toHaveLength(1);
    expect(errors.errors[0]?.url).toBe("http://127.0.0.1:1/");

    const slowBatch = await fc.startBatchScrape(
      Array.from({ length: 10 }, (_, i) => `${slow.url}/wide/${i}`),
      { maxConcurrency: 1 },
    );
    await Bun.sleep(500);
    expect(await fc.cancelBatchScrape(slowBatch.id)).toBe(true);
  }, 30_000);
});

describe("extract", () => {
  test("extract with polling returns the data", async () => {
    const r = await fc.extract({
      urls: [`${tree.url}/d1`],
      prompt: "the heading",
      schema: { type: "object", properties: { heading: { type: "string" } } },
      pollInterval: 1,
      timeout: 30,
    });
    expect(r.status).toBe("completed");
    expect(r.data).toEqual({ heading: "Page /d1" });
  }, 30_000);

  test("startExtract and getExtractStatus", async () => {
    const started = await fc.startExtract({ urls: [`${tree.url}/d2`], prompt: "the heading" });
    expect(started.id).toBeTruthy();
    let status = await fc.getExtractStatus(started.id as string);
    for (let i = 0; i < 200 && status.status === "processing"; i++) {
      await Bun.sleep(100);
      status = await fc.getExtractStatus(started.id as string);
    }
    expect(status.status).toBe("completed");
    expect(status.data).toEqual({ heading: "Page /d2" });
  }, 30_000);
});

describe("failures are requested once", () => {
  // The SDK retries 502s, which for an LLM-backed request means paying for the same failure several times.
  test("deterministic failures reach the server exactly once", async () => {
    let requests = 0;
    const counting = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        requests++;
        const headers = new Headers(req.headers);
        headers.delete("host");
        return fetch(new URL(new URL(req.url).pathname, srv.url), { method: req.method, headers, body: req.body });
      },
    });
    try {
      const client = new Firecrawl({ apiUrl: `http://127.0.0.1:${counting.port}`, apiKey: "unused" });
      const cases: Array<[string, () => Promise<unknown>]> = [
        ["unsupported format", () => client.scrape(`${tree.url}/d1`, { formats: ["branding" as never] })],
        ["refused connection", () => client.scrape("http://127.0.0.1:1/")],
        ["bad schema", () => client.scrape(`${tree.url}/d1`, { formats: [{ type: "json", schema: { type: "no-such-type" } } as never] })],
      ];
      for (const [name, call] of cases) {
        requests = 0;
        const failure = await call().then(
          () => undefined,
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        expect(failure, name).toBeDefined();
        expect(requests, name).toBe(1);
      }
    } finally {
      counting.stop(true);
    }
  }, 60_000);
});

describe("apps/sex/test/sdk-smoke.ts", () => {
  // The script scrapes real sites (stephango.com, bun.com), so it needs the internet; without it the test is skipped.
  test("passes against a running server", async () => {
    const online = await fetch("https://example.com", { signal: AbortSignal.timeout(5000) }).then(
      (r) => r.ok,
      () => false,
    );
    if (!online) {
      console.warn("sdk-smoke.ts skipped: no internet");
      return;
    }
    const open = await startSex(["--searxng-url", searxng.url], { privateNetwork: false });
    const proc = Bun.spawn(["bun", "apps/sex/test/sdk-smoke.ts", open.url], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    await open.stop();
    expect(`${out}\n${err}`).not.toContain("FAIL");
    expect(code).toBe(0);
    for (const step of ["scrape", "search", "map", "crawl (waiter)", "batch scrape (waiter)", "crawl cancel", "error mapping"])
      expect(out).toContain(`ok   ${step}`);
  }, 120_000);
});
