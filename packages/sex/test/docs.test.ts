import { afterAll, describe, expect, test } from "bun:test";
import { Deadline } from "@sex/core/deadline.ts";
import { AppError } from "@sex/core/errors.ts";
import { MARKUP_TYPE } from "@sex/core/net.ts";
import { DocsConverter } from "../src/engine/docs.ts";
import { testEngine } from "./helpers.ts";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url));

/** A text PDF with one line per page ("Text page N"), built by hand. */
function textPdf(pages: number): Uint8Array {
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

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
};

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const name = new URL(req.url).pathname.slice(1);
    const body = name === "text3.pdf" ? textPdf(3) : await fixture(name).bytes();
    return new Response(body, { headers: { "content-type": TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream" } });
  },
});
const at = (name: string) => `http://127.0.0.1:${site.port}/${name}`;

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected rejection");
}

const docs = testEngine({ docs: true });
const plain = testEngine();
// here-docs ships native engines for a fixed set of hosts; elsewhere these tests have nothing to run against.
const available = await docs.docs.warmup().then(
  () => true,
  (err) => {
    console.warn(`skipping here-docs tests: ${(err as Error).message}`);
    return false;
  },
);

afterAll(async () => {
  site.stop(true);
  await docs.close();
  await plain.close();
});

describe.skipIf(!available)("SEX_DOCS (here-docs)", () => {
  test("a scanned PDF is OCR'd", async () => {
    const doc = await docs.scrape({ url: at("scan.pdf") });
    expect(doc.markdown).toContain("Scanned invoice 4711");
    expect(doc.metadata?.numPages).toBe(1);
  });

  test("parsers maxPages stops after that many pages and says so", async () => {
    const doc = await docs.scrape({ url: at("text3.pdf"), parsers: [{ type: "pdf", maxPages: 2 }] });
    expect(doc.markdown).toContain("Text page 2");
    expect(doc.markdown).not.toContain("Text page 3");
    expect(doc.metadata?.numPages).toBe(3);
    expect(doc.warning).toContain("first 2 of 3 pages");
  });

  test("a Word document keeps its structure", async () => {
    const doc = await docs.scrape({ url: at("report.docx") });
    expect(doc.markdown).toContain("Revenue grew **12%** year over year.");
    expect(doc.markdown).toContain("| EMEA | 42 |");
  });

  test('images are OCR\'d unless the parsers list leaves out "image"', async () => {
    expect((await docs.scrape({ url: at("hello.png") })).markdown).toContain("HELLO");
    const err = await rejection(docs.scrape({ url: at("hello.png"), parsers: ["pdf"] }));
    expect({ status: err.status, code: err.code }).toEqual({ status: 415, code: "UNSUPPORTED_FILE" });
  });

  test("a conversion over its deadline is a 408 SCRAPE_TIMEOUT", async () => {
    const bytes = await fixture("scan.pdf").bytes();
    const err = await rejection(docs.docs.convert(bytes, { deadline: Deadline.start(1) }));
    expect({ status: err.status, code: err.code }).toEqual({ status: 408, code: "SCRAPE_TIMEOUT" });
  });

  test("a cancelled request stops the conversion with 408 TIMEOUT", async () => {
    const bytes = await fixture("scan.pdf").bytes();
    const err = await rejection(docs.docs.convert(bytes, { deadline: Deadline.start(60_000, { signal: AbortSignal.abort() }) }));
    expect({ status: err.status, code: err.code }).toEqual({ status: 408, code: "TIMEOUT" });
  });

  test("unrecognised bytes are a 415", async () => {
    const err = await rejection(docs.docs.convert(new Uint8Array([0, 1, 2, 3]), { deadline: Deadline.start(10_000) }));
    expect({ status: err.status, code: err.code }).toEqual({ status: 415, code: "UNSUPPORTED_FILE" });
  });
});

describe("without SEX_DOCS", () => {
  test("PDFs fall back to unpdf, which honours maxPages too", async () => {
    const doc = await plain.scrape({ url: at("text3.pdf"), parsers: [{ type: "pdf", maxPages: 2 }] });
    expect(doc.markdown).toContain("Text page 2");
    expect(doc.markdown).not.toContain("Text page 3");
    expect(doc.metadata?.numPages).toBe(3);
  });

  test("office documents and images are unsupported", async () => {
    for (const name of ["report.docx", "hello.png"]) {
      const err = await rejection(plain.scrape({ url: at(name) }));
      expect({ status: err.status, code: err.code }).toEqual({ status: 415, code: "UNSUPPORTED_FILE" });
    }
  });

  test("the converter is never started", () => {
    expect(new DocsConverter(plain.config).enabled).toBe(false);
  });
});

test("OOXML office documents are not mistaken for markup", () => {
  expect(MARKUP_TYPE.test("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
  for (const t of ["text/html; charset=utf-8", "application/xhtml+xml", "application/xml", "text/xml", "application/rss+xml"]) {
    expect(MARKUP_TYPE.test(t)).toBe(true);
  }
});
