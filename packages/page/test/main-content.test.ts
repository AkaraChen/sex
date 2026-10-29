import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractFromHtmlInline, type PageExtractOptions } from "@searxng-js/sex-page";

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
    assert.ok(r.markdown.includes("word39"));
    assert.equal(r.defuddle.wordCount, 40);
    assert.deepEqual(r.notes, ["No main content was detected on the page, so the whole body was converted."]);
  });

  test("a short page that really is short is left alone", async () => {
    const r = await extractFromHtmlInline(`<html><body><p>${words(5)}</p></body></html>`, opts());
    assert.ok(r.markdown.includes("word4"));
    assert.deepEqual(r.notes, []);
  });

  test("a page with real main content does not run a second extraction", async () => {
    const html = `<html><body><nav><a href="/">Home</a></nav><article><p>${words(300)}</p></article></body></html>`;
    const r = await extractFromHtmlInline(html, opts());
    assert.deepEqual(r.notes, []);
    assert.ok(!r.markdown.includes("Home"));
  });

  test("onlyMainContent=false is already the whole body and needs no retry", async () => {
    const r = await extractFromHtmlInline(`<html><body><nav><p>${words(40)}</p></nav></body></html>`, opts({ onlyMainContent: false }));
    assert.ok(r.markdown.includes("word39"));
    assert.deepEqual(r.notes, []);
  });

  test("the second extraction sees the whole page: metadata and links come from the untouched document", async () => {
    const html = `<html lang="en"><head><title>T</title></head><body><nav><a href="/x">x</a><p>${words(40)}</p></nav></body></html>`;
    const r = await extractFromHtmlInline(html, opts({ wantLinks: true }));
    assert.equal(r.metadata.title, "T");
    assert.deepEqual(r.links, ["https://example.com/x"]);
  });
});

describe("huge pages", () => {
  const card = (i: number) => `<div class="card"><a href="/p/${i}">Post ${i}</a><p>Text of card ${i}.</p></div>`;
  const page = `<html><body><nav><a href="/">Home</a></nav><article><p>${words(300)}</p></article>${Array.from({ length: 50 }, (_, i) => card(i)).join("")}</body></html>`;

  test("below the element limit main content is detected as usual", async () => {
    const r = await extractFromHtmlInline(page, opts());
    assert.deepEqual(r.notes, []);
    assert.ok(r.markdown.includes("word299"));
    assert.ok(!r.markdown.includes("Post 49"));
  });

  test("above the limit only the body is converted, and a note says so", async () => {
    const r = await extractFromHtmlInline(page, opts({ maxScoredElements: 100 }));
    assert.ok(r.markdown.includes("word299"));
    assert.ok(r.markdown.includes("Post 49"));
    assert.equal(r.notes.length, 1);
    assert.match(String(r.notes[0]), /^The page has \d+ elements, so its main content was not detected/);
  });

  test("the limit does not apply when the whole body is wanted anyway", async () => {
    const r = await extractFromHtmlInline(page, opts({ onlyMainContent: false, maxScoredElements: 100 }));
    assert.deepEqual(r.notes, []);
  });
});
