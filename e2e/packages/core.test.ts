import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMockLlm } from "../lib/llm.ts";
import { killAll } from "../lib/proc.ts";
import { startMockSearxng } from "../lib/sites.ts";
import { removeTempDirs, tempDir } from "../lib/tmp.ts";
import { bunProject, consumeOk, consumerSite, nodeProject, type Runtime, sharedDone } from "./support.ts";

// The same programs, written the way an outside project would, run under Node 24 and under Bun against installed tarballs.
const site = consumerSite();
const searxng = startMockSearxng(site.url);
const llm = startMockLlm(() => JSON.stringify({ title: "Doc A from the model" }));

const projects: Record<Runtime, string> = { node: "", bun: "" };
beforeAll(async () => {
  [projects.node, projects.bun] = await Promise.all([nodeProject(), bunProject()]);
});
afterAll(async () => {
  site.stop();
  searxng.stop();
  llm.stop();
  await killAll();
  removeTempDirs();
  sharedDone();
});

for (const runtime of ["node", "bun"] as const) {
  describe(`core programs on ${runtime}`, () => {
    const cfg = () => ({ siteUrl: site.url, searxngUrl: searxng.url });
    const cfg2 = () => ({ siteUrl: site.url, llmUrl: llm.url });

    test("sex-egress safeFetch fetches a local page when private networks are allowed and refuses one otherwise", async () => {
      const before = site.hits.filter((h) => h === "/private").length;
      const r = await consumeOk(projects[runtime], runtime, "egress.mjs", cfg());
      expect(r.status).toBe(200);
      expect(r.contentType).toContain("text/html");
      expect(r.text).toContain("Home");
      expect(r.refused).toEqual({ isAppError: true, code: "PRIVATE_NETWORK_BLOCKED", status: 403, retryable: false });
      // the refused address was never connected to
      expect(site.hits.filter((h) => h === "/private").length).toBe(before);
    });

    test("sex-scrape scrapeUrl returns markdown and links", async () => {
      const r = await consumeOk(projects[runtime], runtime, "scrape.mjs", cfg());
      expect(r.markdown).toContain("Alpha unique marker");
      expect(r.links).toContain(`${site.url}/docs/b`);
      expect(r.title).toBe("Doc A");
      expect(r.status).toBe(200);
    });

    test("sex-search search queries an external SearXNG and can scrape the results", async () => {
      const r = await consumeOk(projects[runtime], runtime, "search.mjs", cfg());
      expect(r.urls).toContain(`${site.url}/docs/a`);
      expect(r.scrapedMarkdown).toContain("Alpha unique marker");
    });

    test("sex-map mapSite reads the sitemap", async () => {
      const r = await consumeOk(projects[runtime], runtime, "map.mjs", cfg());
      expect(r.urls).toEqual(expect.arrayContaining([`${site.url}/docs/a`, `${site.url}/docs/b`, `${site.url}/docs/c`]));
    });

    test("sex-page: ExtractPool worker, extractFromHtmlInline, markdownToHtml", async () => {
      const r = await consumeOk(projects[runtime], runtime, "page.mjs", cfg());
      expect(r.pooledMarkdown).toContain("extraction pools");
      expect(r.inlineMarkdown).toBe(r.pooledMarkdown);
      expect(r.pooledLinks).toContain("https://example.com/out");
      expect(r.rendered).toContain("<table>");
      expect(r.rendered).toContain("<del>x</del>");
      expect(r.rendered).not.toContain("<script>");
    });

    test("sex-store: cache and change tracker on node:sqlite, and a scrape served from the cache", async () => {
      const dir = tempDir("store-");
      const r = await consumeOk(projects[runtime], runtime, "store.mjs", { ...cfg(), dir });
      expect(r.missBefore).toBe(true);
      expect(r.hitBody).toBe("<p>cached</p>");
      expect(r.hitStatus).toBe(200);
      expect(r.tracked).toBe("line one\nline two\n");
      expect(r.diffFiles).toBe(1);
      expect(r.diffText).toContain("-b");
      expect(r.diffText).toContain("+c");
      expect(r.secondState).toBe("hit");
      expect(r.sameMarkdown).toBe(true);
    });

    test("diagnostics channels deliver messages", async () => {
      const r = await consumeOk(projects[runtime], runtime, "diagnostics.mjs", { dir: tempDir("diag-") });
      expect(r.messages.length).toBeGreaterThan(0);
      const [m] = r.messages;
      expect(["debug", "info", "warn", "error"]).toContain(m.level);
      expect(typeof m.msg).toBe("string");
      expect(m.fields === undefined || typeof m.fields === "object").toBe(true);
    });

    test("sex-jobs runs a batch and a crawl to completion on a MemoryTaskQueue", async () => {
      const r = await consumeOk(projects[runtime], runtime, "jobs.mjs", { ...cfg(), dir: tempDir("jobs-") });
      expect(r.batch).toMatchObject({ status: "completed", total: 2, completed: 2 });
      expect(r.batch.docs).toEqual([`${site.url}/docs/a`, `${site.url}/docs/b`]);
      expect(r.batch.markdown).toContain("Alpha unique marker");
      expect(r.crawl.status).toBe("completed");
      expect(r.crawl.docs).toEqual(expect.arrayContaining([`${site.url}/`, `${site.url}/docs/a`, `${site.url}/docs/b`]));
      // the jobs channel carried the worker's debug lines
      expect(r.taskMessages).toBeGreaterThan(0);
    });

    test("sex-llm answers the json format from an OpenAI-compatible endpoint and is a 501 without one", async () => {
      const r = await consumeOk(projects[runtime], runtime, "llm.mjs", cfg2());
      expect(r.enabled).toBe(true);
      expect(r.disabledEnabled).toBe(false);
      expect(r.json).toEqual({ title: "Doc A from the model" });
      expect(r.unconfigured).toEqual({ isAppError: true, code: "LLM_NOT_CONFIGURED", status: 501 });
      expect(llm.requests.length).toBeGreaterThan(0);
      expect(llm.requests[0]?.model).toBe("mock-model");
    });

    test("sex-browser imports and, without a browser binary, fails the scrape with a clear 501", async () => {
      const r = await consumeOk(projects[runtime], runtime, "browser.mjs", cfg());
      expect(r).toMatchObject({ blocksAds: true, blocksOther: false, exception: false, planType: "function" });
      expect(r.enabled).toEqual({ lightpanda: true, off: false });
      expect(r.browserScrape.ok).toBe(false);
      expect(r.browserScrape.isAppError).toBe(true);
      expect(["BROWSER_NOT_CONFIGURED", "BROWSER_UNAVAILABLE"]).toContain(r.browserScrape.code);
      expect(r.browserScrape.message).toMatch(/lightpanda/i);
    });

    test("sex-docs imports; disabled it refuses an office file with 415, enabled it warms up or says DOCS_UNAVAILABLE", async () => {
      const r = await consumeOk(projects[runtime], runtime, "docs.mjs", cfg());
      expect(r.offEnabled).toBe(false);
      expect(r.docxOff).toEqual({ isAppError: true, code: "UNSUPPORTED_FILE", status: 415 });
      if (!r.warmup.ok) expect(r.warmup).toMatchObject({ isAppError: true, code: "DOCS_UNAVAILABLE" });
    });

    // Every published package exports AppError (fixed in 0.1.1; it used to be bundled but not exported).
    test("a published package exports AppError, so a consumer can follow the README and call AppError.isInstance", async () => {
      const r = await consumeOk(projects[runtime], runtime, "apperror.mjs", cfg());
      expect(r.exporters.length).toBeGreaterThan(0);
      expect(r.works).toBe(true);
    });
  });
}
