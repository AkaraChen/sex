import { parentPort } from "node:worker_threads";
import { extractFromHtmlInline } from "./page.ts";
import { pdfToMarkdown } from "./pdf.ts";

// node:worker_threads works the same under Bun and Node.
const port = parentPort;
port?.on("message", async (e: { id: number; kind: string; html: string; pdf: Uint8Array; maxPages?: number; opts: never }) => {
  const { id, kind, html, pdf, maxPages, opts } = e;
  try {
    const result = kind === "pdf" ? await pdfToMarkdown(pdf, maxPages) : await extractFromHtmlInline(html, opts);
    port.postMessage({ id, ok: true, result });
  } catch (err) {
    const e2 = err as { code?: string; message?: string };
    port.postMessage({ id, ok: false, code: e2.code, message: e2.message ?? String(err) });
  }
});
