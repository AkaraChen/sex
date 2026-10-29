// Errors are this class (bundled in every package, recognised across them by AppError.isInstance, never instanceof).
export { AppError, type ErrorCode } from "@searxng-js/sex-errors";
export { ExtractPool, type ExtractPoolOptions } from "./extract-pool.ts";
export { markdownToHtml } from "./markdown-html.ts";
export { extractFromHtmlInline, PAGE_SCRIPT, type PageExtractOptions, type PageExtractResult } from "./page.ts";
export { joinPages, type PdfPage, type PdfText, pdfToMarkdown } from "./pdf.ts";
