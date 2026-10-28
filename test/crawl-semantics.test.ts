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
  "/r/": () => html("Redirects", `${link("/r/out")} ${link("/r/dup")} ${link("/r/block")} ${link("/r/target")}`),
  "/r/target": () => html("Target", ""),
  "/deep/page": () => html("Deep", ""),
  "/files/": () =>
    html("Files", `${link("/files/a.zip")} ${link("/files/b.png")} ${link("/files/c.mp4")} ${link("/files/d.pdf")} ${link("/files/page")}`),
  "/files/page": () => html("File page", ""),
  "/scoped/": () => html("Scoped", ""),
  "/scoped/a": () => html("Scoped A", ""),
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
        if (pathname === "/scoped/sitemap.xml") {
          const locs = [1, 2, 3, 4, 5].map((n) => `${baseUrl}/o${n}`).concat(`${baseUrl}/scoped/a`);
          return new Response(`<urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`, {
            headers: { "content-type": "application/xml" },
          });
        }
        if (pathname === "/ext/") {
          return html("Ext", link(`http://localhost:${site.port}/ext/other`) + link(`http://localhost:${site.port}/`));
        }
        if (pathname === "/ext/other") return html("Other", link(`http://localhost:${site.port}/ext/deeper`) + link(`${baseUrl}/ext/back`));
        if (pathname === "/ext/deeper" || pathname === "/ext/back") return html(pathname, "");
        if (pathname === "/r/out") return Response.redirect(`http://localhost:${site.port}/docs/intro`, 302);
        if (pathname === "/r/dup") return Response.redirect(`${baseUrl}/r/target`, 302);
        if (pathname === "/r/block") return Response.redirect(`${baseUrl}/private/x`, 302);
        if (pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /private/\n");
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

  test("a redirect target is checked for scope, robots and duplicates before the document is kept", async () => {
    const job = await finished(engine, await engine.crawl({ url: `${baseUrl}/r/`, sitemap: "skip" }));
    expect(await sourceUrls(engine, job.id)).toEqual([`${baseUrl}/r/`, `${baseUrl}/r/target`]);
    expect(await engine.jobs.store.robotsBlocked(job.id)).toContain(`${baseUrl}/private/x`);
    expect(
      (await engine.jobs.store.errors(job.id)).some((e) => e.url === `${baseUrl}/r/out` && e.error.includes("outside the crawl scope")),
    ).toBe(true);
  });

  test("external links are followed one hop only, and never to an external home page", async () => {
    const job = await finished(engine, await engine.crawl({ url: `${baseUrl}/ext/`, allowExternalLinks: true, sitemap: "skip" }));
    expect(await sourceUrls(engine, job.id)).toEqual([`${baseUrl}/ext/`, `${baseUrl}/ext/back`, `http://localhost:${site.port}/ext/other`]);
  });

  test("links to archives, media and images are skipped, documents are kept", async () => {
    const job = await finished(engine, await engine.crawl({ url: `${baseUrl}/files/`, sitemap: "skip" }));
    const pagesCrawled = (await sourceUrls(engine, job.id)).concat((await engine.jobs.store.errors(job.id)).map((e) => e.url));
    expect(pagesCrawled.some((u) => /\.(zip|png|mp4)$/.test(u))).toBe(false);
    expect(pagesCrawled).toContain(`${baseUrl}/files/page`);
    expect(pagesCrawled.some((u) => u.endsWith("/files/d.pdf"))).toBe(true);
  });

  test("sitemap URLs are filtered before the limit is applied and the scope directory's sitemap is read", async () => {
    const job = await finished(engine, await engine.crawl({ url: `${baseUrl}/scoped/`, limit: 2 }));
    expect(await sourceUrls(engine, job.id)).toEqual([`${baseUrl}/scoped/`, `${baseUrl}/scoped/a`]);
  });

  test("risky include/exclude regexes are rejected with 400", async () => {
    await expect(engine.crawl({ url: `${baseUrl}/`, includePaths: ["^(a+)+$"] })).rejects.toMatchObject({ status: 400 });
    await expect(engine.crawl({ url: `${baseUrl}/`, excludePaths: ["(a|a)*b"] })).rejects.toMatchObject({ status: 400 });
  });

  test("prompt-derived risky regexes are dropped", async () => {
    llmReply = JSON.stringify({ includePaths: ["^(a+)+$", "^/blog"] });
    const job = await llmEngine.crawl({ url: `${baseUrl}/`, prompt: "x" });
    expect((job.options as Record<string, unknown>).includePaths).toEqual(["^/blog"]);
  });
});
