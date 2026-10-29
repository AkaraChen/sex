import { parentPort } from "node:worker_threads";
import { extractFromHtmlInline } from "./page.ts";
import { pdfToMarkdown } from "./pdf.ts";

const port = parentPort;
if (!port) throw new Error("extract-worker.ts runs as a worker thread (see extract-pool.ts)");
port.on("message", async (data) => {
  const { id, kind, html, pdf, maxPages, opts } = data;
  try {
    const result = kind === "pdf" ? await pdfToMarkdown(pdf, maxPages) : await extractFromHtmlInline(html, opts);
    port.postMessage({ id, ok: true, result });
  } catch (err) {
    const e2 = err as { code?: string; message?: string };
    port.postMessage({ id, ok: false, code: e2.code, message: e2.message ?? String(err) });
  }
});
