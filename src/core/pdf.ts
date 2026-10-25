import { AppError } from "../errors.ts";

export interface PdfText {
  markdown: string;
  title?: string;
  numPages: number;
}

/** Plain text extraction; pages are separated by horizontal rules. */
export async function pdfToMarkdown(data: Uint8Array): Promise<PdfText> {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const [{ text, totalPages }, meta] = await Promise.all([
      extractText(pdf, { mergePages: false }),
      getMeta(pdf).catch(() => ({ info: {} as Record<string, unknown> })),
    ]);
    const title = typeof meta.info.Title === "string" && meta.info.Title.trim() ? meta.info.Title.trim() : undefined;
    return {
      markdown: text.map((page) => page.trim()).join("\n\n---\n\n"),
      title,
      numPages: totalPages,
    };
  } catch (err) {
    throw new AppError(422, "PDF_PARSE_FAILED", `Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`);
  }
}
