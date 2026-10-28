import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppError } from "@sex/core/errors.ts";
import type { Engine } from "../src/engine/engine.ts";
import { chatCompletionStream, startFixtureSite, startMockLlm, startMockSearxng, testEngine } from "./helpers.ts";

let site: ReturnType<typeof startFixtureSite>;
let searx: ReturnType<typeof startMockSearxng>;
let llm: ReturnType<typeof startMockLlm>;
let engine: Engine;
let llmEngine: Engine;

beforeAll(() => {
  site = startFixtureSite();
  searx = startMockSearxng(site.url);
  llm = startMockLlm((body) => {
    if (body.response_format) return JSON.stringify({ title: "Doc A", paragraphs: 4 });
    return "A short summary.";
  });
  engine = testEngine({ searxngUrl: searx.url });
  llmEngine = testEngine({ searxngUrl: searx.url, llmModel: "test-model", llmBaseUrl: llm.url, llmApiKey: "k" });
});

afterAll(async () => {
  await engine.close();
  await llmEngine.close();
  site.stop();
  searx.stop();
  llm.stop();
});

describe("scrape", () => {
  test("main content markdown with metadata", async () => {
    const doc = await engine.scrape({ url: `${site.url}/docs/a`, formats: ["markdown", "links", "images", "rawHtml"] });
    expect(doc.markdown).toStartWith("# Doc A");
    expect(doc.markdown).toContain("Paragraph 1 about doc a");
    expect(doc.markdown).not.toContain("footer text");
    expect(doc.links).toContain(`${site.url}/docs/b`);
    expect(doc.images).toContain(`${site.url}/img/a.png`);
    expect(doc.rawHtml).toContain("<footer>");
    expect(doc.metadata).toMatchObject({
      title: "Doc A",
      description: "About Doc A",
      ogTitle: "Doc A OG",
      language: "en",
      statusCode: 200,
      sourceURL: `${site.url}/docs/a`,
      contentType: "text/html",
    });
  });

  test("onlyMainContent:false keeps page chrome; excludeTags removes it", async () => {
    const full = await engine.scrape({ url: `${site.url}/docs/a`, onlyMainContent: false });
    expect(full.markdown).toContain("footer text");
    const trimmed = await engine.scrape({ url: `${site.url}/docs/a`, onlyMainContent: false, excludeTags: ["footer", "nav"] });
    expect(trimmed.markdown).not.toContain("footer text");
  });

  test("follows redirects and reports the final URL", async () => {
    const doc = await engine.scrape({ url: `${site.url}/redirect` });
    expect(doc.metadata?.url).toBe(`${site.url}/docs/a`);
    expect(doc.metadata?.sourceURL).toBe(`${site.url}/redirect`);
  });

  test("non-HTML text and HTTP errors", async () => {
    const json = await engine.scrape({ url: `${site.url}/data.json` });
    expect(json.markdown).toContain('"hello"');
    const missing = await engine.scrape({ url: `${site.url}/nope` });
    expect(missing.metadata?.statusCode).toBe(404);
  });

  test("blocks private addresses unless allowed", async () => {
    const strict = testEngine({ allowPrivateNetwork: false });
    await expect(strict.scrape({ url: `${site.url}/` })).rejects.toMatchObject({ code: "PRIVATE_NETWORK_BLOCKED", status: 403 });
    await strict.close();
  });

  test("browser-only and LLM-only features fail with 501 when not configured", async () => {
    await expect(engine.scrape({ url: site.url, formats: ["screenshot"] })).rejects.toMatchObject({ code: "NOT_SUPPORTED", status: 501 });
    await expect(engine.scrape({ url: site.url, actions: [{ type: "screenshot" }] })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expect(engine.scrape({ url: site.url, actions: [{ type: "scrape" }] })).rejects.toMatchObject({ code: "BROWSER_NOT_CONFIGURED" });
    await expect(engine.scrape({ url: site.url, formats: ["summary"] })).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
    await expect(engine.extract({ urls: [site.url], prompt: "x" })).rejects.toBeInstanceOf(AppError);
  });

  test("LLM formats", async () => {
    const doc = await llmEngine.scrape({
      url: `${site.url}/docs/a`,
      formats: ["markdown", "summary", { type: "json", schema: { type: "object", properties: { title: { type: "string" } } } }],
    });
    expect(doc.summary).toBe("A short summary.");
    expect(doc.json).toEqual({ title: "Doc A", paragraphs: 4 });
    const schemaCall = llm.requests.find((r) => r.response_format?.type === "json_schema");
    expect(schemaCall?.messages[1]?.content).toContain("Paragraph 1 about doc a");
  });

  test("JSON extraction retries without response_format when the endpoint rejects json_schema", async () => {
    const formats: Array<string | undefined> = [];
    const strict = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { response_format?: { type: string } };
        formats.push(body.response_format?.type);
        if (body.response_format) return new Response("json_schema not supported", { status: 400 });
        return chatCompletionStream('```json\n{"title":"Doc A"}\n```');
      },
    });
    const e = testEngine({ llmModel: "m", llmBaseUrl: `http://127.0.0.1:${strict.port}/v1` });
    try {
      const doc = await e.scrape({ url: `${site.url}/docs/a`, formats: [{ type: "json", schema: { type: "object" } }] });
      expect(doc.json).toEqual({ title: "Doc A" });
      expect(formats).toEqual(["json_schema", undefined]);
    } finally {
      strict.stop(true);
      await e.close();
    }
  });
});

describe("search", () => {
  test("maps SearXNG results to Firecrawl shape and strips highlight markers", async () => {
    const { data } = await engine.search({ query: "docs", limit: 2, sources: ["web", "news", "images"] });
    expect(data.web).toEqual([
      { url: `${site.url}/docs/a`, title: "Doc A", description: "About doc a", position: 1 },
      { url: `${site.url}/docs/b`, title: "Doc B", description: "About doc b", position: 2 },
    ]);
    expect(data.news?.[1]).toMatchObject({ title: "Doc B", snippet: "About doc b", date: "2026-01-01" });
    expect(data.images?.length).toBe(2);
  });

  test("domain filters and result scraping", async () => {
    const { data } = await engine.search({
      query: "docs",
      excludeDomains: ["other.example"],
      limit: 5,
      scrapeOptions: { formats: ["markdown"] },
    });
    expect(data.web?.map((r) => r.url)).toEqual([`${site.url}/docs/a`, `${site.url}/docs/b`]);
    expect(data.web?.[0]?.markdown).toStartWith("# Doc A");
  });
});

describe("map", () => {
  test("combines page links and sitemap, scoped to the site", async () => {
    const { links } = await engine.map({ url: site.url });
    const urls = links.map((l) => l.url);
    expect(urls).toContain(`${site.url}/`);
    expect(urls).toContain(`${site.url}/docs/a`);
    expect(urls).toContain(`${site.url}/docs/c`);
    expect(urls).not.toContain("https://other.example/x");
  });

  test("search ranks matching URLs first", async () => {
    const { links } = await engine.map({ url: site.url, search: "private" });
    expect(links[0]?.url).toBe(`${site.url}/private/x`);
  });

  test("filterByPath keeps the start path by default and can be turned off", async () => {
    const scoped = await engine.map({ url: `${site.url}/docs/a` });
    expect(scoped.links.map((l) => l.url).every((u) => new URL(u).pathname.startsWith("/docs/a"))).toBe(true);
    expect(scoped.links.map((l) => new URL(l.url).pathname)).not.toContain("/docs/b");
    const all = await engine.map({ url: `${site.url}/docs/a`, filterByPath: false });
    expect(all.links.map((l) => new URL(l.url).pathname)).toContain("/docs/b");
  });

  test("includePaths and excludePaths match the path", async () => {
    const inc = await engine.map({ url: site.url, includePaths: ["^/docs/"] });
    expect(inc.links.length).toBeGreaterThan(0);
    expect(inc.links.every((l) => new URL(l.url).pathname.startsWith("/docs/"))).toBe(true);
    const exc = await engine.map({ url: site.url, excludePaths: ["^/docs/"] });
    expect(exc.links.map((l) => new URL(l.url).pathname)).not.toContain("/docs/a");
  });

  test("unsafe path regexes are rejected", async () => {
    await expect(engine.map({ url: site.url, includePaths: ["(a+)+$"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("returns an id, and a warning when almost nothing is found", async () => {
    const full = await engine.map({ url: site.url });
    expect(full.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(full.warning).toBeUndefined();
    const empty = await engine.map({ url: site.url, includePaths: ["^/nothing-here$"] });
    expect(empty.links).toEqual([]);
    expect(empty.warning).toBeString();
  });

  test("useIndex and ignoreCache are accepted and ignored", async () => {
    const { links } = await engine.map({ url: site.url, useIndex: false, ignoreCache: true });
    expect(links.length).toBeGreaterThan(1);
  });

  test("the entry redirect decides the host", async () => {
    const hop = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.redirect(`${site.url}/docs/`, 302) });
    try {
      const { links } = await engine.map({ url: `http://localhost:${hop.port}/` });
      const urls = links.map((l) => l.url);
      expect(urls).toContain(`${site.url}/docs/b`);
      expect(urls.every((u) => u.startsWith(site.url))).toBe(true);
    } finally {
      hop.stop(true);
    }
  });
});
