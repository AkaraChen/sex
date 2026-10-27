import { extractFromHtmlInline } from "./page.ts";
import { pdfToMarkdown } from "./pdf.ts";

declare const self: Worker;
self.onmessage = async (e: MessageEvent) => {
  const { id, kind, html, pdf, maxPages, opts } = e.data;
  try {
    const result = kind === "pdf" ? await pdfToMarkdown(pdf, maxPages) : await extractFromHtmlInline(html, opts);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    const e2 = err as { status?: number; code?: string; message?: string };
    self.postMessage({ id, ok: false, status: e2.status, code: e2.code, message: e2.message ?? String(err) });
  }
};
