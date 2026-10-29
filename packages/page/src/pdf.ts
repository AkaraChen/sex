import { AppError } from "@searxng-js/sex-errors";

/** One physical page of a PDF (1-based), as `parsers: [{ type: "pdf", pages: true }]` returns it in `Document.pages`. */
export interface PdfPage {
  pageNumber: number;
  markdown: string;
}

const PAGE_BREAK = "\n\n---\n\n";

/**
 * Joins pages into one Markdown text. With `pageMarkers` each page after the first is preceded by `---` and
 * `<!-- page N -->` (Firecrawl's format); without, they are separated by a `---` line. With markers empty pages are left out, so
 * the numbers may skip.
 */
export function joinPages(pages: readonly PdfPage[], pageMarkers: boolean): string {
  let out = "";
  for (const page of pages) {
    if (!page.markdown.trim() && pageMarkers) continue;
    if (out) out += pageMarkers ? `${PAGE_BREAK}<!-- page ${page.pageNumber} -->\n\n` : PAGE_BREAK;
    out += page.markdown;
  }
  return out;
}

export interface PdfText {
  markdown: string;
  /** The same text page by page, empty pages included. */
  pages: PdfPage[];
  title?: string;
  /** Pages actually extracted: `min(totalPages, maxPages)`. */
  numPages: number;
  /** Pages in the whole document. */
  totalPages: number;
}

/** Plain text extraction, page by page, stopping after `maxPages`; pages are separated by horizontal rules. */
export async function pdfToMarkdown(data: Uint8Array, maxPages?: number): Promise<PdfText> {
  const { getDocumentProxy, getMeta } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    pdf = await getDocumentProxy(new Uint8Array(data));
    const totalPages = pdf.numPages;
    const numPages = Math.min(totalPages, maxPages ?? totalPages);
    const pages: PdfPage[] = [];
    // One page at a time: pages past `maxPages` are never parsed.
    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const markdown = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .trim();
      pages.push({ pageNumber: i, markdown });
      page.cleanup();
    }
    const meta = await getMeta(pdf).catch(() => ({ info: {} as Record<string, unknown> }));
    const title = typeof meta.info.Title === "string" && meta.info.Title.trim() ? meta.info.Title.trim() : undefined;
    return { markdown: joinPages(pages, false), pages, title, numPages, totalPages };
  } catch (err) {
    throw new AppError("PDF_PARSE_FAILED", `Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // unpdf leaves the lifecycle of a proxy we created to us; this frees the document's pages and loading task.
    await pdf?.loadingTask.destroy().catch(() => {});
  }
}
