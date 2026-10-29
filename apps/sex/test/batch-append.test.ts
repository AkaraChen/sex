// appendToId: appended URLs use the append request's own options, and are never dropped
// when the original batch finishes at the same time as the append.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/engine/engine.ts";
import type { JobRecord } from "../src/engine/jobs/index.ts";
import { testEngine, waitFor } from "./helpers.ts";

const paragraphs = Array.from(
  { length: 4 },
  (_, i) => `<p>Paragraph ${i + 1} about slow pages. ${"Lorem ipsum dolor sit amet. ".repeat(8)}</p>`,
).join("");
const htmlPage = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><article><h1>${title}</h1>${body}</article></main></body></html>`;

function startSlowFastSite() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const headers = { "content-type": "text/html; charset=utf-8" };
      if (pathname === "/slow") {
        await Bun.sleep(300);
        return new Response(htmlPage("Slow", paragraphs), { headers });
      }
      if (pathname === "/fast") return new Response(htmlPage("Fast", paragraphs), { headers });
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function finished(engine: Engine, id: string): Promise<JobRecord> {
  return waitFor(async () => {
    const j = await engine.getJob(id, "batch_scrape");
    return j.status !== "scraping" ? j : undefined;
  });
}

async function documents(engine: Engine, id: string) {
  return (await engine.jobs.store.documents(id, 0, 1e9)).data;
}

describe("batch appendToId", () => {
  let site: ReturnType<typeof startSlowFastSite>;
  let engine: Engine;

  beforeAll(() => {
    site = startSlowFastSite();
    engine = testEngine();
  });

  afterAll(() => {
    site.stop();
  });

  test("appended URLs are scraped with the append request's options", async () => {
    const { job } = await engine.batchScrape({ urls: [`${site.url}/fast`], formats: ["markdown"] });
    await finished(engine, job.id);

    await engine.batchScrape({ urls: [`${site.url}/fast?x=2`], formats: ["html"], appendToId: job.id });
    await waitFor(async () => {
      const j = await engine.getJob(job.id, "batch_scrape");
      return j.status === "completed" && j.completed === 2 ? j : undefined;
    });

    const docs = await documents(engine, job.id);
    expect(docs.length).toBe(2);
    expect(docs[0]?.markdown).toBeDefined();
    expect(docs[1]?.html).toBeDefined();
    expect(docs[1]?.markdown).toBeUndefined();
  });

  test("appended URLs are not dropped when the original batch finishes during the append", async () => {
    const { job } = await engine.batchScrape({ urls: [`${site.url}/slow`] });

    // Let the original page finish right after reopen() runs (inside the append), before the append's tasks are queued.
    const store = engine.jobs.store;
    const orig = store.reopen.bind(store);
    store.reopen = async (id: string) => {
      await orig(id);
      const until = Date.now() + 1000;
      while ((await store.get(id))?.status === "scraping" && Date.now() < until) await Bun.sleep(10);
    };
    try {
      await engine.batchScrape({ urls: [`${site.url}/fast`], appendToId: job.id });
    } finally {
      store.reopen = orig;
    }

    const done = await waitFor(async () => {
      const j = await engine.getJob(job.id, "batch_scrape");
      return j.status === "completed" && j.completed === 2 ? j : undefined;
    });
    expect(done.status).toBe("completed");
    expect((await documents(engine, job.id)).length).toBe(2);
  });
});
