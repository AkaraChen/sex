import { AppError } from "../errors.ts";

export interface PdfText {
  markdown: string;
  title?: string;
  numPages: number;
}

/** Plain text extraction; pages are separated by horizontal rules. Only the first `maxPages` pages are kept. */
export async function pdfToMarkdown(data: Uint8Array, maxPages?: number): Promise<PdfText> {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    pdf = await getDocumentProxy(new Uint8Array(data));
    const [{ text, totalPages }, meta] = await Promise.all([
      extractText(pdf, { mergePages: false }),
      getMeta(pdf).catch(() => ({ info: {} as Record<string, unknown> })),
    ]);
    const title = typeof meta.info.Title === "string" && meta.info.Title.trim() ? meta.info.Title.trim() : undefined;
    return {
      markdown: text
        .slice(0, maxPages)
        .map((page) => page.trim())
        .join("\n\n---\n\n"),
      title,
      numPages: totalPages,
    };
  } catch (err) {
    throw new AppError("PDF_PARSE_FAILED", `Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // unpdf leaves the lifecycle of a proxy we created to us; this frees the document's pages and loading task.
    await pdf?.loadingTask.destroy().catch(() => {});
  }
}
