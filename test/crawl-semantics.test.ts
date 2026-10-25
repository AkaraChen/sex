// Crawl scope, query handling, sitemap depth and prompt-derived options, matching Firecrawl v2 semantics.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/core/engine.ts";
import type { JobRecord } from "../src/core/jobs/index.ts";
import { startMockLlm, testEngine, waitFor } from "./helpers.ts";

const link = (href: string) => `<a href="${href}">${href}</a>`;
const html = (title: string, body: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><article><h1>${title}</h1>
<p>${title} content, long enough to be kept by the extractor. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
${body}</article></main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const pages: Record<string, () => Response> = {
  "/docs": () => html("Docs", `${link("/docs/intro")} ${link("/blog/post")} ${link("/pricing")}`),
  "/docs/intro": () => html("Intro", ""),
  "/blog/post": () => html("Blog", ""),
  "/pricing": () => html("Pricing", ""),
  "/docs/index.html": () => html("Docs index", `${link("/docs/child")} ${link("/blog/post")}`),
  "/docs/child": () => html("Child", ""),
  "/products": () => html("Products", ""),
  "/hub/": () => html("Hub", `${link("/hub/a?x=1")} ${link("/hub/a?x=2")}`),
  "/hub/a": () => html("Hub A", ""),
  "/": () => html("Home", ""),
  "/deep/page": () => html("Deep", ""),
};

describe("crawl semantics", () => {
  let site: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let llm: ReturnType<typeof startMockLlm>;
  let llmReply = "{}";
  let engine: Engine;
  let llmEngine: Engine;

  beforeAll(() => {
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/sitemap.xml") {
          return new Response(`<?xml version="1.0"?><urlset><url><loc>${baseUrl}/deep/page</loc></url></urlset>`, {
            headers: { "content-type": "application/xml" },
          });
        }
        const page = pages[pathname];
        return page ? page() : new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${site.port}`;
    llm = startMockLlm(() => llmReply);
    engine = testEngine();
    llmEngine = testEngine({ llmModel: "m", llmBaseUrl: llm.url });
  });

  afterAll(async () => {
    await engine.close();
    await llmEngine.close();
    site.stop(true);
    llm.stop();
  });

  const finished = (e: Engine, job: JobRecord) =>
    waitFor(async () => {
      const j = await e.getJob(job.id, "crawl");
      return j.status === "scraping" ? undefined : j;
    });
  const sourceUrls = async (e: Engine, id: string) =>
    (await e.jobs.store.documents(id, 0, 1e9)).data.map((d) => d.metadata?.sourceURL as string).sort();

  test("a start URL without trailing slash only follows its own section", async () => {
    const job = await finished(engine, await engine.crawl({ url: `${baseUrl}/docs`, sitemap: "skip" }));
    expect(await sourceUrls(engine, job.id)).toEqual([`${baseUrl}/docs`, `${baseUrl}/docs/intro`]);
  });

  test("a start URL pointing at a file means its directory", async () => {
    const job = await finished(engine, await engine.crawl({ url: `${baseUrl}/docs/index.html`, sitemap: "skip" }));
    expect(await sourceUrls(engine, job.id)).toEqual([`${baseUrl}/docs/child`, `${baseUrl}/docs/index.html`]);
  });

  test("ignoreQueryParameters keeps the query in the fetched start URL", async () => {
    const job = await finished(
      engine,
      await engine.crawl({ url: `${baseUrl}/products?category=shoes`, ignoreQueryParameters: true, limit: 1, sitemap: "skip" }),
    );
    const urls = await sourceUrls(engine, job.id);
    expect(urls.length).toBe(1);
    expect(urls[0]?.endsWith("?category=shoes")).toBe(true);
  });

  test("ignoreQueryParameters dedupes links that differ only by query", async () => {
    const job = await finished(engine, await engine.crawl({ url: `${baseUrl}/hub/`, ignoreQueryParameters: true, sitemap: "skip" }));
    const urls = await sourceUrls(engine, job.id);
    expect(urls.filter((u) => u.includes("/hub/a")).length).toBe(1);
  });

  test("sitemap URLs have discovery depth 0", async () => {
    const job = await finished(engine, await engine.crawl({ url: `${baseUrl}/`, maxDiscoveryDepth: 0 }));
    expect(await sourceUrls(engine, job.id)).toContain(`${baseUrl}/deep/page`);
  });

  test("sitemap only still crawls the start URL", async () => {
    const job = await finished(engine, await engine.crawl({ url: `${baseUrl}/docs`, sitemap: "only" }));
    expect(await sourceUrls(engine, job.id)).toContain(`${baseUrl}/docs`);
  });

  test("prompt-derived options with the wrong type are dropped instead of breaking the crawl", async () => {
    llmReply = JSON.stringify({ includePaths: "^/blog", allowExternalLinks: "false", limit: 5 });
    const job = await llmEngine.crawl({ url: `${baseUrl}/`, prompt: "x" });
    const options = job.options as Record<string, unknown>;
    expect(options).not.toHaveProperty("includePaths");
    expect(options).not.toHaveProperty("allowExternalLinks");
    expect(options.limit).toBe(5);
  });

  test("the MCP default limit sits below prompt-derived and explicit limits", async () => {
    llmReply = JSON.stringify({ limit: 50 });
    const fromPrompt = await llmEngine.crawl({ url: `${baseUrl}/`, prompt: "x" }, { limit: 20 });
    expect((fromPrompt.options as Record<string, unknown>).limit).toBe(50);

    const plain = await engine.crawl({ url: `${baseUrl}/` }, { limit: 20 });
    expect((plain.options as Record<string, unknown>).limit).toBe(20);
  });
});
