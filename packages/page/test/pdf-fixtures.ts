/** A text PDF with one line per page ("Text page N"), built by hand. */
export function textPdf(pages: number): Uint8Array {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 18 Tf 20 100 Td (Text page ${i + 1}) Tj ET`;
    kids.push(`${objs.length + 1} 0 R`);
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents ${objs.length + 2} 0 R /Resources << /Font << /F1 ${2 + pages * 2 + 1} 0 R >> >> >>`,
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
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
