// Crawl / batch / extract through the job store and task queue.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/engine/engine.ts";
import type { JobKind, JobRecord } from "../src/engine/jobs/index.ts";
import { startFixtureSite, startMockLlm, testEngine, waitFor } from "./helpers.ts";

{
  describe("jobs", () => {
    let site: ReturnType<typeof startFixtureSite>;
    let llm: ReturnType<typeof startMockLlm>;
    let engine: Engine;
    let llmEngine: Engine;

    beforeAll(() => {
      site = startFixtureSite();
      llm = startMockLlm(() => JSON.stringify({ title: "Doc A" }));
      engine = testEngine();
      llmEngine = testEngine({ llmModel: "m", llmBaseUrl: llm.url });
    });

    afterAll(async () => {
      await engine.close();
      await llmEngine.close();
      site.stop();
      llm.stop();
    });

    const finished = (e: Engine, job: JobRecord, kind: JobKind) =>
      waitFor(async () => {
        const j = await e.getJob(job.id, kind);
        return j.status === "scraping" ? undefined : j;
      });
    const docs = async (e: Engine, id: string) => (await e.jobs.store.documents(id, 0, 1e9)).data;

    test("crawl follows links, obeys robots.txt and filters", async () => {
      const job = await finished(engine, await engine.crawl({ url: `${site.url}/`, limit: 10, sitemap: "skip" }), "crawl");
      expect(job.status).toBe("completed");
      const urls = (await docs(engine, job.id)).map((d) => d.metadata?.sourceURL).sort();
      expect(urls).toEqual([`${site.url}/`, `${site.url}/docs/a`, `${site.url}/docs/b`]);
      expect(job.completed).toBe(3);
      expect(await engine.jobs.store.robotsBlocked(job.id)).toEqual([`${site.url}/private/x`]);

      const scoped = await finished(
        engine,
        await engine.crawl({ url: `${site.url}/`, includePaths: ["^/docs/b$"], sitemap: "skip" }),
        "crawl",
      );
      // The start page feeds discovery but is filtered out of the results.
      expect((await docs(engine, scoped.id)).map((d) => d.metadata?.sourceURL)).toEqual([`${site.url}/docs/b`]);
    });

    test("crawl limit, depth and sitemap seeding", async () => {
      const limited = await finished(engine, await engine.crawl({ url: `${site.url}/`, limit: 2, sitemap: "skip" }), "crawl");
      expect((await docs(engine, limited.id)).length).toBe(2);

      const shallow = await finished(engine, await engine.crawl({ url: `${site.url}/`, maxDiscoveryDepth: 0, sitemap: "skip" }), "crawl");
      expect((await docs(engine, shallow.id)).map((d) => d.metadata?.sourceURL)).toEqual([`${site.url}/`]);

      const fromSitemap = await finished(engine, await engine.crawl({ url: `${site.url}/`, sitemap: "only" }), "crawl");
      const pages = (await docs(engine, fromSitemap.id)).map((d) => [d.metadata?.sourceURL, d.metadata?.statusCode]).sort();
      // The start URL plus sitemap URLs, no link following; a 404 is still a document carrying its status code.
      expect(pages).toEqual([
        [`${site.url}/`, 200],
        [`${site.url}/docs/b`, 200],
        [`${site.url}/docs/c`, 404],
      ]);
    });

    test("delay spaces out page fetches", async () => {
      const started = Date.now();
      await finished(engine, await engine.crawl({ url: `${site.url}/`, limit: 3, delay: 0.2, sitemap: "skip" }), "crawl");
      expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    });

    test("cancel stops a crawl", async () => {
      const job = await engine.crawl({ url: `${site.url}/`, limit: 10, delay: 1, sitemap: "skip" });
      await engine.cancelJob(job);
      const done = await engine.getJob(job.id, "crawl");
      expect(done.status).toBe("cancelled");
      await expect(engine.cancelJob(done)).rejects.toMatchObject({ status: 409 });
    });

    test("batch scrape, including appendToId", async () => {
      const { job } = await engine.batchScrape({ urls: [`${site.url}/docs/a`, `${site.url}/docs/b`], formats: ["markdown"] });
      let done = await finished(engine, job, "batch_scrape");
      expect(done).toMatchObject({ status: "completed", total: 2, completed: 2 });
      await engine.batchScrape({ urls: [`${site.url}/`], appendToId: job.id });
      done = await waitFor(async () => {
        const j = await engine.getJob(job.id, "batch_scrape");
        return j.status === "completed" && j.completed === 3 ? j : undefined;
      });
      expect((await docs(engine, job.id)).length).toBe(3);
    });

    test("extract", async () => {
      const { job } = await llmEngine.extract({
        urls: [`${site.url}/docs/a`],
        prompt: "Get the title",
        schema: { type: "object" },
        showSources: true,
      });
      const done = await finished(llmEngine, job, "extract");
      expect(done.status).toBe("completed");
      expect(done.result).toEqual({ title: "Doc A" });
      expect(done.sources).toEqual({ "*": [`${site.url}/docs/a`] });
    });

    test("active crawls", async () => {
      const job = await engine.crawl({ url: `${site.url}/`, limit: 10, delay: 1, sitemap: "skip" });
      expect((await engine.jobs.store.active("crawl")).map((j) => j.id)).toContain(job.id);
      await engine.cancelJob(job);
      expect((await engine.jobs.store.active("crawl")).map((j) => j.id)).not.toContain(job.id);
    });
  });
}
