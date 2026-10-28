import { AppError } from "./errors.ts";

export interface PdfText {
  markdown: string;
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
    const pages: string[] = [];
    // One page at a time: pages past `maxPages` are never parsed.
    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
          .join("")
          .trim(),
      );
      page.cleanup();
    }
    const meta = await getMeta(pdf).catch(() => ({ info: {} as Record<string, unknown> }));
    const title = typeof meta.info.Title === "string" && meta.info.Title.trim() ? meta.info.Title.trim() : undefined;
    return { markdown: pages.join("\n\n---\n\n"), title, numPages, totalPages };
  } catch (err) {
    throw new AppError("PDF_PARSE_FAILED", `Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // unpdf leaves the lifecycle of a proxy we created to us; this frees the document's pages and loading task.
    await pdf?.loadingTask.destroy().catch(() => {});
  }
}
