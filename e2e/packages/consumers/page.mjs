import { ExtractPool, extractFromHtmlInline, joinPages, markdownToHtml } from "@searxng-js/sex-page";
import { report } from "./common.mjs";

const html = `<!doctype html><html><head><title>T</title></head><body><nav><a href="/x">nav</a></nav><main><article><h1>Heading</h1>${"<p>Some text about extraction pools and workers in a page. </p>".repeat(8)}<a href="https://example.com/out">out</a></article></main></body></html>`;
const opts = { url: "https://example.com/", onlyMainContent: true, removeBase64Images: true, wantLinks: true, wantImages: false };
const pool = new ExtractPool({ size: 2, taskTimeoutMs: 30_000 });
let pooled;
try {
  pooled = await pool.html(html, opts, AbortSignal.timeout(20_000));
} finally {
  await pool.close();
}
const inline = await extractFromHtmlInline(html, opts);
const rendered = await markdownToHtml("# Hi\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~x~~ <script>alert(1)</script>");
report({
  pooledMarkdown: pooled.markdown,
  pooledLinks: pooled.links,
  inlineMarkdown: inline.markdown,
  rendered,
  joined: joinPages(
    [
      { pageNumber: 1, markdown: "one" },
      { pageNumber: 2, markdown: "two" },
    ],
    true,
  ),
});
