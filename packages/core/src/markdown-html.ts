/**
 * The `html` / `rawHtml` of a converted document (PDF, office file): its Markdown rendered by Bun's built-in CommonMark
 * renderer, which is GFM-aware (tables, strikethrough, task lists). The Markdown comes from untrusted files, so raw HTML in
 * it is escaped, not passed through. Link targets are left as written (a `javascript:` URL in a PDF stays in the href), as
 * the output is data for the caller to sanitise, like any other scraped HTML.
 */
export function markdownToHtml(markdown: string): string {
  return Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true });
}
