import assert from "node:assert/strict";
import { test } from "node:test";
import { joinPages, pdfToMarkdown } from "@searxng-js/sex-page";
import { textPdf } from "./pdf-fixtures.ts";

/** A one-page PDF with the text "Hello PDF", built by hand. */
function minimalPdf(): Uint8Array {
  const stream = "BT /F1 12 Tf 20 100 Td (Hello PDF) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, o] of objs.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("extracts text from a PDF repeatedly (document proxy is destroyed each time)", async () => {
  for (let i = 0; i < 3; i++) {
    const pdf = await pdfToMarkdown(minimalPdf());
    assert.match(pdf.markdown, /Hello PDF/);
    assert.equal(pdf.numPages, 1);
  }
});

test("a corrupt PDF is a 422", async () => {
  const err = await pdfToMarkdown(new TextEncoder().encode("%PDF-1.4 garbage")).catch((e: unknown) => e);
  assert.equal((err as { code?: string }).code, "PDF_PARSE_FAILED");
});

test("returns the pages one by one, empty ones included", async () => {
  const pdf = await pdfToMarkdown(textPdf(3));
  assert.deepEqual(
    pdf.pages,
    [1, 2, 3].map((n) => ({ pageNumber: n, markdown: `Text page ${n}` })),
  );
  assert.equal(pdf.markdown, joinPages(pdf.pages, false));
  const limited = await pdfToMarkdown(textPdf(3), 2);
  assert.deepEqual(
    limited.pages.map((p) => p.pageNumber),
    [1, 2],
  );
});

test("joinPages: markers go between pages, empty pages are skipped when marking", () => {
  const pages = [
    { pageNumber: 1, markdown: "one" },
    { pageNumber: 2, markdown: "" },
    { pageNumber: 3, markdown: "three" },
  ];
  assert.equal(joinPages(pages, true), "one\n\n---\n\n<!-- page 3 -->\n\nthree");
  assert.equal(joinPages(pages, false), "one\n\n---\n\n\n\n---\n\nthree");
  assert.equal(joinPages([{ pageNumber: 4, markdown: "x" }], true), "x");
});
