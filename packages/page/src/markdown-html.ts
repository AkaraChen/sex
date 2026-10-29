import { AppError } from "@searxng-js/sex-errors";

/**
 * The `html` / `rawHtml` of a converted document (PDF, office file): its Markdown rendered as GFM (tables, strikethrough, task
 * lists). The Markdown comes from untrusted files, so raw HTML in it is escaped, not passed through. Link targets are left as
 * written (a `javascript:` URL in a PDF stays in the href), as the output is data for the caller to sanitise, like any other
 * scraped HTML.
 *
 * On Bun this is Bun's built-in CommonMark renderer. Elsewhere it is `marked` (an optional peer dependency): install it, or
 * this throws.
 */
export async function markdownToHtml(markdown: string): Promise<string> {
  if (typeof Bun !== "undefined") return Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true });
  return (await markedRenderer())(markdown);
}

let renderer: Promise<(markdown: string) => string> | undefined;

function markedRenderer(): Promise<(markdown: string) => string> {
  renderer ??= import("marked").then(
    ({ Marked }) => {
      const marked = new Marked({
        gfm: true,
        async: false,
        // Block and inline raw HTML arrive as `html` tokens: print them as text.
        renderer: { html: ({ text }) => escapeHtml(text) },
      });
      return (markdown) => marked.parse(markdown, { async: false });
    },
    (cause) => {
      renderer = undefined;
      throw new AppError(
        "NOT_SUPPORTED",
        "Converting Markdown to HTML outside Bun needs the optional peer dependency `marked`: run `npm install marked`.",
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    },
  );
  return renderer;
}

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
