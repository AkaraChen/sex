// Document conversion with here-docs (`--docs`): Word, scanned PDF (OCR), images, parsers, /v2/parse uploads.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { textPdf } from "@searxng-js/sex-testing";
import { FIXTURES } from "../lib/bin.ts";
import { api, killAll, type Server } from "../lib/proc.ts";
import { type Site, site, staticSite } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { scrape, startSex } from "./helpers.ts";

let docs: Server;
let plain: Server;
let files: Site;
let pdfs: Site;

const MULTI = textPdf(4);

beforeAll(async () => {
  files = staticSite();
  pdfs = site((_req, url) => {
    if (url.pathname === "/four.pdf") return new Response(MULTI, { headers: { "content-type": "application/pdf" } });
    if (url.pathname === "/broken.pdf") return new Response("this is not a pdf", { headers: { "content-type": "application/pdf" } });
    if (url.pathname === "/broken.docx")
      return new Response("PK\x03\x04junk", {
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      });
    return new Response("nf", { status: 404 });
  });
  docs = await startSex(["--docs"]);
  plain = await startSex();
});

afterAll(async () => {
  files.stop();
  pdfs.stop();
  await killAll();
  removeTempDirs();
});

const upload = async (
  srv: Server,
  name: string,
  content: ConstructorParameters<typeof File>[0][number],
  options?: unknown,
  type?: string,
) => {
  const fd = new FormData();
  fd.set("file", new File([content], name, type ? { type } : undefined));
  if (options !== undefined) fd.set("options", JSON.stringify(options));
  const res = await fetch(new URL("/v2/parse", srv.url), { method: "POST", body: fd });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
};

describe("fetching documents by URL", () => {
  test("health says docs are on", async () => {
    const r = await api(docs.url, "/health");
    expect(r.status).toBe(200);
    expect(r.body.docs).toContain("here-docs");
    expect((await api(plain.url, "/health")).body.docs).not.toContain("here-docs");
  });

  test("a Word document becomes Markdown with its table", async () => {
    const r = await scrape(docs, { url: `${files.url}/report.docx`, formats: ["markdown", "html"] });
    expect(r.status).toBe(200);
    const { markdown, html, metadata } = r.body.data;
    expect(markdown).toContain("Quarterly report");
    expect(markdown).toContain("**12%**");
    expect(markdown).toContain("| Region | Sales |");
    expect(markdown).toContain("| EMEA | 42 |");
    // html is the Markdown rendered (and raw HTML in it escaped), so the table is a real <table>.
    expect(html).toContain("<table>");
    expect(html).toContain("EMEA");
    expect(metadata.contentType).toContain("wordprocessingml");
    expect(metadata.statusCode).toBe(200);
  });

  test("a scanned PDF is read by OCR", async () => {
    const r = await scrape(docs, { url: `${files.url}/scan.pdf`, formats: ["markdown"] });
    expect(r.status).toBe(200);
    expect(r.body.data.markdown).toContain("Scanned invoice 4711");
    expect(r.body.data.markdown).toContain("128.50");
    expect(r.body.data.metadata.numPages).toBe(1);
    expect(r.body.data.metadata.totalPages).toBe(1);
  });

  test("an image is read by OCR", async () => {
    const r = await scrape(docs, { url: `${files.url}/hello.png`, formats: ["markdown"] });
    expect(r.status).toBe(200);
    expect(r.body.data.markdown).toContain("HELLO");
  });

  test("an explicit parsers list without image leaves an image unsupported (415)", async () => {
    const r = await scrape(docs, { url: `${files.url}/hello.png`, parsers: ["pdf"] });
    expect(r.status).toBe(415);
    expect(r.body.code).toBe("UNSUPPORTED_FILE");
  });

  test("parsers without pdf return the file as base64", async () => {
    const r = await scrape(docs, { url: `${files.url}/scan.pdf`, formats: ["markdown"], parsers: ["image"] });
    expect(r.status).toBe(200);
    expect(r.body.data.markdown.startsWith("JVBERi0")).toBe(true); // "%PDF-" in base64
    expect(r.body.data.metadata.contentType).toBe("application/pdf");
  });

  test("a PDF with several pages: maxPages, per-page output and page markers", async () => {
    const all = await scrape(docs, { url: `${pdfs.url}/four.pdf`, formats: ["markdown"] });
    expect(all.status).toBe(200);
    for (const n of [1, 2, 3, 4]) expect(all.body.data.markdown).toContain(`Text page ${n}`);
    expect(all.body.data.metadata.numPages).toBe(4);
    expect(all.body.data.metadata.totalPages).toBe(4);

    const two = await scrape(docs, {
      url: `${pdfs.url}/four.pdf`,
      formats: ["markdown"],
      parsers: [{ type: "pdf", maxPages: 2, pages: true, pageMarkers: true }],
    });
    expect(two.status).toBe(200);
    const d = two.body.data;
    expect(d.markdown).toContain("Text page 1");
    expect(d.markdown).toContain("Text page 2");
    expect(d.markdown).not.toContain("Text page 3");
    expect(d.metadata.numPages).toBe(2);
    expect(d.metadata.totalPages).toBe(4);
    expect(d.warning).toContain("2");
    expect(d.pages.map((p: any) => p.pageNumber)).toEqual([1, 2]);
    expect(d.pages[1].markdown).toContain("Text page 2");
    // Markers sit between pages (not before the first one).
    expect(d.markdown).toContain("<!-- page 2 -->");
    expect(d.markdown).toContain("---");
    expect(d.markdown.indexOf("<!-- page 2 -->")).toBeGreaterThan(d.markdown.indexOf("Text page 1"));
    expect(d.markdown).not.toContain("<!-- page 1 -->");
  });

  test("a broken PDF and a broken Word file are 422 DOCUMENT_PARSE_FAILED", async () => {
    const pdf = await scrape(docs, { url: `${pdfs.url}/broken.pdf` });
    expect(pdf.status).toBe(422);
    expect(["DOCUMENT_PARSE_FAILED", "PDF_PARSE_FAILED"]).toContain(pdf.body.code);
    const docx = await scrape(docs, { url: `${pdfs.url}/broken.docx` });
    expect(docx.status).toBe(422);
    expect(docx.body.code).toBe("DOCUMENT_PARSE_FAILED");
  });

  test("a document that is not there keeps the 404 status", async () => {
    const r = await scrape(docs, { url: `${files.url}/nothing.docx` });
    expect(r.status).toBe(200);
    expect(r.body.data.metadata.statusCode).toBe(404);
  });
});

describe("without --docs", () => {
  test("a text PDF still works (unpdf) and obeys maxPages and page markers", async () => {
    const r = await scrape(plain, {
      url: `${pdfs.url}/four.pdf`,
      formats: ["markdown"],
      parsers: [{ type: "pdf", maxPages: 3, pages: true, pageMarkers: true }],
    });
    expect(r.status).toBe(200);
    expect(r.body.data.metadata.numPages).toBe(3);
    expect(r.body.data.metadata.totalPages).toBe(4);
    expect(r.body.data.pages).toHaveLength(3);
    expect(r.body.data.markdown).toContain("Text page 3");
    expect(r.body.data.markdown).not.toContain("Text page 4");
    expect(r.body.data.markdown).toContain("<!-- page 3 -->");
  });

  test("Office documents and images are 415", async () => {
    const docx = await scrape(plain, { url: `${files.url}/report.docx` });
    expect(docx.status).toBe(415);
    expect(docx.body.code).toBe("UNSUPPORTED_FILE");
    const png = await scrape(plain, { url: `${files.url}/hello.png` });
    expect(png.status).toBe(415);
  });
});

describe("POST /v2/parse", () => {
  test("uploads a Word file with options", async () => {
    const r = await upload(docs, "report.docx", Bun.file(`${FIXTURES}/report.docx`), { formats: ["markdown", "html"] });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.markdown).toContain("| EMEA | 42 |");
    expect(r.body.data.html).toContain("<table>");
    expect(r.body.data.metadata.sourceURL).toBe("report.docx");
  });

  test("uploads a scanned PDF (OCR) and an image", async () => {
    const pdf = await upload(docs, "scan.pdf", Bun.file(`${FIXTURES}/scan.pdf`), undefined, "application/pdf");
    expect(pdf.status).toBe(200);
    expect(pdf.body.data.markdown).toContain("Scanned invoice 4711");
    const png = await upload(docs, "hello.png", Bun.file(`${FIXTURES}/hello.png`));
    expect(png.status).toBe(200);
    expect(png.body.data.markdown).toContain("HELLO");
  });

  test("honours parsers options on an uploaded PDF", async () => {
    const r = await upload(
      docs,
      "four.pdf",
      MULTI,
      { formats: ["markdown"], parsers: [{ type: "pdf", maxPages: 1, pages: true }] },
      "application/pdf",
    );
    expect(r.status).toBe(200);
    expect(r.body.data.pages).toHaveLength(1);
    expect(r.body.data.metadata.totalPages).toBe(4);
  });

  test("a PDF parses without --docs; an Office file or image is 415", async () => {
    const pdf = await upload(plain, "four.pdf", MULTI, undefined, "application/pdf");
    expect(pdf.status).toBe(200);
    expect(pdf.body.data.markdown).toContain("Text page 1");
    const docx = await upload(plain, "report.docx", Bun.file(`${FIXTURES}/report.docx`));
    expect(docx.status).toBe(415);
  });

  test("corrupted files are 422", async () => {
    const pdf = await upload(docs, "bad.pdf", "not a pdf at all", undefined, "application/pdf");
    expect(pdf.status).toBe(422);
    expect(pdf.body.code).toBe("DOCUMENT_PARSE_FAILED");
    const docx = await upload(docs, "bad.docx", "PK\x03\x04junk");
    expect(docx.status).toBe(422);
    expect(docx.body.code).toBe("DOCUMENT_PARSE_FAILED");
  });

  test("actions and rawBase64 are refused, invalid options are a 400, no file is a 4xx", async () => {
    const actions = await upload(docs, "four.pdf", MULTI, { actions: [{ type: "wait", milliseconds: 10 }] }, "application/pdf");
    expect([400, 501]).toContain(actions.status);
    const raw = await upload(docs, "four.pdf", MULTI, { formats: ["rawBase64"] }, "application/pdf");
    expect(raw.status).toBe(400);
    const badOptions = await upload(docs, "four.pdf", MULTI, { formats: ["nonsense"] }, "application/pdf");
    expect(badOptions.status).toBe(400);
    const fd = new FormData();
    fd.set("options", "{}");
    const res = await fetch(new URL("/v2/parse", docs.url), { method: "POST", body: fd });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("a file above SEX_MAX_BODY_BYTES is 413", async () => {
    const small = await startSex([], { env: { SEX_MAX_BODY_BYTES: "2048" } });
    const r = await upload(small, "big.pdf", new Uint8Array(4096), undefined, "application/pdf");
    expect(r.status).toBe(413);
    await small.stop();
  });
});
