import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Firecrawl from "@mendable/firecrawl-js";
import { bin } from "../lib/bin.ts";
import { killAll, type Server, serve } from "../lib/proc.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { mockSearx, pagesSite } from "./support.ts";

// The official Firecrawl JS SDK pointed at sex-lite (apps/sex/test/sdk-smoke.ts is the manual version of this).

const lite = bin("sex-lite");
const pages = pagesSite();
const searx = mockSearx(() => [
  { url: `${pages.url}/article`, title: "Article", content: "the article" },
  { url: `${pages.url}/gone`, title: "Gone", content: "a 404 page" },
  { url: "https://github.com/o/r", title: "Repo", content: "a repository" },
]);
let s: Server;
let fc: Firecrawl;

beforeAll(async () => {
  s = await serve(lite, ["--allow-private-network"], { env: { SEX_SEARXNG_URL: searx.url } });
  fc = new Firecrawl({ apiUrl: s.url, apiKey: "unused", maxRetries: 1 });
});
afterAll(async () => {
  await s.stop();
  pages.stop();
  searx.stop();
  await killAll();
  removeTempDirs();
});

/** What the SDK throws carries the HTTP status in some property, depending on its version. */
async function failure(fn: () => Promise<unknown>): Promise<{ message: string; status?: number }> {
  try {
    await fn();
  } catch (e: any) {
    return { message: String(e?.message ?? e), status: e?.status ?? e?.statusCode ?? e?.response?.status };
  }
  throw new Error("expected the call to fail");
}

describe("scrape through the SDK", () => {
  test("default: markdown and metadata", async () => {
    const d = await fc.scrape(`${pages.url}/article`);
    expect(d.markdown).toContain("# Heading One");
    expect(d.metadata?.statusCode).toBe(200);
    expect(d.metadata?.title).toBe("Test Article");
    expect(d.metadata?.sourceURL).toBe(`${pages.url}/article`);
  });

  test("formats, tags and options", async () => {
    const d = await fc.scrape(`${pages.url}/article`, {
      formats: ["markdown", "html", "rawHtml", "links", "images"],
      onlyMainContent: false,
      excludeTags: [".ad-slot"],
      timeout: 20000,
    });
    expect(d.html).toContain("Heading One");
    expect(d.rawHtml).toContain("AD-SLOT-TEXT");
    expect(d.markdown).not.toContain("AD-SLOT-TEXT");
    expect(d.links).toContain(`${pages.url}/other`);
    expect(d.images).toContain(`${pages.url}/img/one.png`);
  });

  test("a 404 page comes back as a document", async () => {
    const d = await fc.scrape(`${pages.url}/gone`);
    expect(d.metadata?.statusCode).toBe(404);
  });

  test("a PDF", async () => {
    const d = await fc.scrape(`${pages.url}/text-pdf`);
    expect(d.markdown).toContain("Text page 1");
  });

  test("unsupported formats and LLM formats are errors with the server's message", async () => {
    const branding = await failure(() => fc.scrape(`${pages.url}/article`, { formats: ["branding" as any] }));
    expect(branding.message).toContain("branding");
    expect(branding.status).toBe(501);
    const json = await failure(() => fc.scrape(`${pages.url}/article`, { formats: [{ type: "json", prompt: "x" } as any] }));
    expect(json.message).toContain("LLM");
    expect(json.status).toBe(501);
  });

  test("a timeout is an error with status 408", async () => {
    const e = await failure(() => fc.scrape(`${pages.url}/slow?ms=20000`, { timeout: 1000 }));
    expect(e.status).toBe(408);
  });

  test("a bad URL is a 400 and a refused connection a 500", async () => {
    expect((await failure(() => fc.scrape("not a url"))).status).toBe(400);
    expect((await failure(() => fc.scrape("http://127.0.0.1:1/"))).status).toBe(500);
  });

  test("a private URL on a default server is a 403", async () => {
    const strictServer = await serve(lite, [], { env: { SEX_SEARXNG_URL: searx.url } });
    try {
      const c = new Firecrawl({ apiUrl: strictServer.url, apiKey: "unused", maxRetries: 1 });
      const e = await failure(() => c.scrape(`${pages.url}/article`));
      expect(e.status).toBe(403);
      expect(e.message).toContain("private");
    } finally {
      await strictServer.stop();
    }
  });

  test("the SDK's extra body fields (origin, integration) do not trip a default server", async () => {
    const d = await fc.scrape(`${pages.url}/plain`, { integration: "e2e" } as any);
    expect(d.markdown).toContain("plain text");
  });
});

describe("search through the SDK", () => {
  test("web results", async () => {
    const r = await fc.search("anything", { limit: 3 });
    expect(r.web?.map((w: any) => w.url)).toEqual([`${pages.url}/article`, `${pages.url}/gone`, "https://github.com/o/r"]);
    expect((r.web![0] as any).title).toBe("Article");
  });

  test("limit and scrapeOptions", async () => {
    const r = await fc.search("anything", { limit: 2, scrapeOptions: { formats: ["markdown"] } });
    expect(r.web).toHaveLength(2);
    expect((r.web![0] as any).markdown).toContain("Heading One");
    expect((r.web![1] as any).metadata?.statusCode).toBe(404);
  });

  test("a search backend that is down is an error with status 502", async () => {
    const down = await serve(lite, [], { env: { SEX_SEARXNG_URL: "http://127.0.0.1:9" } });
    try {
      const c = new Firecrawl({ apiUrl: down.url, apiKey: "unused", maxRetries: 1 });
      expect((await failure(() => c.search("x"))).status).toBe(502);
    } finally {
      await down.stop();
    }
  });
});

describe("endpoints sex-lite does not have", () => {
  test("map is a 404", async () => {
    expect((await failure(() => fc.map(pages.url))).status).toBe(404);
  });

  test("starting a crawl, a batch scrape or an extract is a 404", async () => {
    expect((await failure(() => fc.startCrawl(pages.url, { limit: 1 }))).status).toBe(404);
    expect((await failure(() => fc.startBatchScrape([`${pages.url}/article`]))).status).toBe(404);
    expect((await failure(() => fc.startExtract({ urls: [`${pages.url}/article`], prompt: "x" } as any))).status).toBe(404);
  });
});
