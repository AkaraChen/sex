// Cancelled requests and jobs stop doing work: queued scrapes never start, extract stops calling the LLM, and full crawls stop discovering links.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/engine/engine.ts";
import type { JobRecord } from "../src/engine/jobs/index.ts";
import { chatCompletionStream, testEngine, waitFor } from "./helpers.ts";

const CDP = process.env.SEX_TEST_CDP_URL;
const body = (title: string, links: string[] = [], repeat = 1) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><article><h1>${title}</h1>` +
  `<p>${title} content, long enough to be kept by the extractor. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(repeat)}</p>` +
  links.map((h) => `<a href="${h}">${h}</a>`).join("") +
  `</article></main></body></html>`;
const htmlResponse = (s: string) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });

async function finished(engine: Engine, id: string, kind: "crawl" | "extract"): Promise<JobRecord> {
  return waitFor(async () => {
    const j = await engine.getJob(id, kind);
    return j.status !== "scraping" ? j : undefined;
  });
}

async function rejection(p: Promise<unknown>): Promise<{ code?: string }> {
  try {
    await p;
  } catch (err) {
    return err as { code?: string };
  }
  throw new Error("expected rejection");
}

describe("queued scrapes", () => {
  let site: ReturnType<typeof Bun.serve>;
  let slowHits = 0;
  let bHits = 0;
  let engine: Engine;

  beforeAll(() => {
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/slow") {
          slowHits++;
          await Bun.sleep(800);
          return htmlResponse(body("Slow"));
        }
        if (pathname === "/b") {
          bHits++;
          return htmlResponse(body("B"));
        }
        return new Response("not found", { status: 404 });
      },
    });
    engine = testEngine({ concurrency: 1 });
  });

  afterAll(async () => {
    site.stop(true);
    await engine.jobs.close();
  });

  test("a scrape aborted while queued never starts", async () => {
    const base = `http://127.0.0.1:${site.port}`;
    const a = engine.scrape({ url: `${base}/slow` });
    const controller = new AbortController();
    const b = engine.scrape({ url: `${base}/b` }, controller.signal);
    await Bun.sleep(50);
    controller.abort();
    const err = await rejection(b);
    expect(err.code).toBe("TIMEOUT");
    await a;
    expect(slowHits).toBe(1);
    expect(bHits).toBe(0);
  }, 15_000);
});

describe("extract cancel", () => {
  let site: ReturnType<typeof Bun.serve>;
  let llm: ReturnType<typeof Bun.serve>;
  let llmRequests = 0;
  let engine: Engine;

  beforeAll(() => {
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        // Each page is longer than the LLM input budget, so every page becomes its own LLM chunk.
        if (pathname.startsWith("/p/")) return htmlResponse(body(`Page ${pathname}`, [], 60));
        return new Response("not found", { status: 404 });
      },
    });
    llm = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        llmRequests++;
        await Bun.sleep(3000);
        return chatCompletionStream("{}");
      },
    });
    // A small input budget gives each page its own LLM chunk; concurrency 1 serialises the LLM calls.
    engine = testEngine({ concurrency: 1, llmModel: "m", llmBaseUrl: `http://127.0.0.1:${llm.port}/v1`, llmMaxInputChars: 1000 });
  });

  afterAll(async () => {
    site.stop(true);
    llm.stop(true);
    await engine.jobs.close();
  });

  test("cancelling an extract stops further LLM calls", async () => {
    const base = `http://127.0.0.1:${site.port}`;
    const { job } = await engine.extract({
      urls: [`${base}/p/1`, `${base}/p/2`, `${base}/p/3`],
      prompt: "Extract the titles",
    });
    await waitFor(() => (llmRequests >= 1 ? true : undefined));
    await engine.cancelJob(job);
    await Bun.sleep(4000);
    expect(llmRequests).toBeLessThanOrEqual(1);
    expect((await engine.getJob(job.id, "extract")).status).toBe("cancelled");
  }, 15_000);
});

describe("crawl limit", () => {
  let site: ReturnType<typeof Bun.serve>;
  let engine: Engine;

  beforeAll(() => {
    const hub = Array.from({ length: 50 }, (_, i) => `/p/${i + 1}`);
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/") return htmlResponse(body("Hub", hub));
        if (pathname.startsWith("/p/")) return htmlResponse(body(`Page ${pathname}`, ["/z/1", "/z/2", "/z/3"]));
        return new Response("not found", { status: 404 });
      },
    });
    engine = testEngine();
  });

  afterAll(async () => {
    site.stop(true);
    await engine.jobs.close();
  });

  test("a full crawl stops discovering links", async () => {
    const store = engine.jobs.store;
    const original = store.schedule.bind(store);
    let discoveries = 0;
    store.schedule = (...args) => {
      discoveries++;
      return original(...args);
    };
    try {
      const base = `http://127.0.0.1:${site.port}`;
      const job = await finished(engine, (await engine.crawl({ url: `${base}/`, limit: 2, sitemap: "skip" })).id, "crawl");
      expect(job.status).toBe("completed");
      expect(job.scheduled).toBe(2);
      // Start page, then the hub's links; the first crawled page is past the limit and must not discover more.
      expect(discoveries).toBeLessThanOrEqual(2);
    } finally {
      store.schedule = original;
    }
  }, 15_000);
});

describe.skipIf(!CDP)("browser abort", () => {
  let site: ReturnType<typeof Bun.serve>;
  let engine: Engine;

  beforeAll(() => {
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        // Never answers: the page stays loading until the client gives up.
        if (new URL(req.url).pathname === "/hang") return new Promise<Response>(() => {});
        if (new URL(req.url).pathname === "/ok") return htmlResponse(body("Ok page", [], 1));
        return new Response("not found", { status: 404 });
      },
    });
    engine = testEngine({ cdpUrl: CDP });
  });

  afterAll(async () => {
    await engine?.browser.close();
    site.stop(true);
  });

  test("aborting a browser scrape rejects with TIMEOUT promptly", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const p = engine.scrape({ url: `http://127.0.0.1:${site.port}/hang` }, controller.signal);
    await Bun.sleep(300);
    controller.abort();
    const err = await rejection(p);
    expect(err.code).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(2000);
  }, 15_000);

  test("the browser still works after an aborted scrape", async () => {
    const doc = await engine.scrape({ url: `http://127.0.0.1:${site.port}/ok`, formats: ["markdown"] });
    expect(doc.markdown).toContain("Ok page");
  }, 15_000);
});
