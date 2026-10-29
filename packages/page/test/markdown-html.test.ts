import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToHtml } from "@searxng-js/sex-page";

// On Bun this is Bun.markdown; on Node it is `marked` (a devDependency here, an optional peer for users).

test("GFM tables, strikethrough and task lists", async () => {
  const html = await markdownToHtml("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~\n\n- [x] done\n- [ ] todo\n");
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>2<\/td>/);
  assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /<input[^>]*type="checkbox"/);
});

test("raw HTML is escaped, as a block and inline", async () => {
  const html = await markdownToHtml('<script>alert(1)</script>\n\ntext <img src=x onerror="alert(2)"> more\n');
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
});

test("ordinary Markdown", async () => {
  assert.equal(
    (await markdownToHtml("# Title\n\nSome **bold** [link](https://example.com/).")).trim(),
    '<h1>Title</h1>\n<p>Some <strong>bold</strong> <a href="https://example.com/">link</a>.</p>',
  );
});
