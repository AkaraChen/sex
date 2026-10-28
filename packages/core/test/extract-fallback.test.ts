import { describe, expect, test } from "bun:test";
import { extractFromHtmlInline, type PageExtractOptions } from "../src/page.ts";
import { scrapeUrl } from "../src/scrape.ts";
import { testCoreEngine } from "./helpers.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const opts = (over: Partial<PageExtractOptions> = {}): PageExtractOptions => ({
  url: "https://example.com/",
  onlyMainContent: true,
  removeBase64Images: true,
  wantLinks: false,
  wantImages: false,
  ...over,
});

describe("main content that comes out empty or thin", () => {
  test("content only inside <nav> is returned from the whole body, with a note", async () => {
    const r = await extractFromHtmlInline(`<html><body><nav><p>${words(40)}</p></nav></body></html>`, opts());
    expect(r.markdown).toContain("word39");
    expect(r.defuddle.wordCount).toBe(40);
    expect(r.notes).toEqual(["No main content was detected on the page, so the whole body was converted."]);
  });

  test("a short page that really is short is left alone", async () => {
    const r = await extractFromHtmlInline(`<html><body><p>${words(5)}</p></body></html>`, opts());
    expect(r.markdown).toContain("word4");
    expect(r.notes).toEqual([]);
  });

  test("a page with real main content does not run a second extraction", async () => {
    const html = `<html><body><nav><a href="/">Home</a></nav><article><p>${words(300)}</p></article></body></html>`;
    const r = await extractFromHtmlInline(html, opts());
    expect(r.notes).toEqual([]);
    expect(r.markdown).not.toContain("Home");
  });

  test("onlyMainContent=false is already the whole body and needs no retry", async () => {
    const r = await extractFromHtmlInline(`<html><body><nav><p>${words(40)}</p></nav></body></html>`, opts({ onlyMainContent: false }));
    expect(r.markdown).toContain("word39");
    expect(r.notes).toEqual([]);
  });

  test("the second extraction sees the whole page: metadata and links come from the untouched document", async () => {
    const html = `<html lang="en"><head><title>T</title></head><body><nav><a href="/x">x</a><p>${words(40)}</p></nav></body></html>`;
    const r = await extractFromHtmlInline(html, opts({ wantLinks: true }));
    expect(r.metadata.title).toBe("T");
    expect(r.links).toEqual(["https://example.com/x"]);
  });
});

describe("huge pages", () => {
  const card = (i: number) => `<div class="card"><a href="/p/${i}">Post ${i}</a><p>Text of card ${i}.</p></div>`;
  const page = `<html><body><nav><a href="/">Home</a></nav><article><p>${words(300)}</p></article>${Array.from({ length: 50 }, (_, i) => card(i)).join("")}</body></html>`;

  test("below the element limit main content is detected as usual", async () => {
    const r = await extractFromHtmlInline(page, opts());
    expect(r.notes).toEqual([]);
    expect(r.markdown).toContain("word299");
    expect(r.markdown).not.toContain("Post 49");
  });

  test("above the limit only the body is converted, and a note says so", async () => {
    const r = await extractFromHtmlInline(page, opts({ maxScoredElements: 100 }));
    expect(r.markdown).toContain("word299");
    expect(r.markdown).toContain("Post 49");
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^The page has \d+ elements, so its main content was not detected/);
  });

  test("the limit does not apply when the whole body is wanted anyway", async () => {
    const r = await extractFromHtmlInline(page, opts({ onlyMainContent: false, maxScoredElements: 100 }));
    expect(r.notes).toEqual([]);
  });
});

describe("scrape", () => {
  test("the extraction's notes become the document's warning", async () => {
    const engine = testCoreEngine();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(`<html><body><nav><p>${words(40)}</p></nav></body></html>`, { headers: { "content-type": "text/html" } }),
    });
    try {
      const { document } = await scrapeUrl(engine, `http://127.0.0.1:${server.port}/`);
      expect(document.markdown).toContain("word39");
      expect(document.warning).toBe("No main content was detected on the page, so the whole body was converted.");
    } finally {
      server.stop(true);
      await engine.close();
    }
  });
});
