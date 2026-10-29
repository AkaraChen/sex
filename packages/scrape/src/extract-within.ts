import type { ExtractPool, PageExtractOptions, PageExtractResult, PdfText } from "@searxng-js/sex-page";
import type { Deadline } from "./deadline.ts";

// The page package only knows an `AbortSignal`: what it throws after the abort is replaced by the deadline's own error
// (`SCRAPE_TIMEOUT` when the time ran out, `TIMEOUT` when the caller cancelled), like `fetchWithin` does.

export async function extractHtmlWithin(
  pool: ExtractPool,
  html: string,
  opts: PageExtractOptions,
  deadline: Deadline,
): Promise<PageExtractResult> {
  try {
    return await pool.html(html, opts, deadline.signal);
  } catch (err) {
    throw deadline.translate(err, "while extracting the page content");
  }
}

export async function extractPdfWithin(
  pool: ExtractPool,
  bytes: Uint8Array,
  maxPages: number | undefined,
  deadline: Deadline,
): Promise<PdfText> {
  try {
    return await pool.pdf(bytes, maxPages, deadline.signal);
  } catch (err) {
    throw deadline.translate(err, "while extracting the PDF text");
  }
}
