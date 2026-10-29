import { afterAll, describe, expect, test } from "bun:test";
import { MARKUP_TYPE } from "@searxng-js/sex-egress";
import { AppError } from "@searxng-js/sex-errors";
import { Deadline } from "@sex/core/deadline.ts";
import { markdownToHtml } from "@sex/core/markdown-html.ts";
import { DocsConverter, type HereDocs } from "../src/engine/docs.ts";
import { testEngine, textPdf } from "./helpers.ts";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url));

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
};

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const name = new URL(req.url).pathname.slice(1);
    if (name === "data.csv") return new Response("name,qty\nwidget,4\ngadget,7\n", { headers: { "content-type": "text/csv" } });
    const body = name === "text3.pdf" ? textPdf(3) : await fixture(name).bytes();
    return new Response(body, { headers: { "content-type": TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream" } });
  },
});
const at = (name: string) => `http://127.0.0.1:${site.port}/${name}`;

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (AppError.isInstance(err)) return err;
    throw err;
  }
  throw new Error("expected rejection");
}

/** text3.pdf's pages joined with pageMarkers; `prefix` is what the converter puts before each page's text. */
const marked = (prefix = "") => [1, 2, 3].map((n) => `${n > 1 ? `---\n\n<!-- page ${n} -->\n\n` : ""}${prefix}Text page ${n}`).join("\n\n");

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
    expect(doc.metadata?.numPages).toBe(2);
    expect(doc.metadata?.totalPages).toBe(3);
    expect(doc.warning).toContain("first 2 of 3 pages");
  });

  test("parsers pages returns each page, pageMarkers marks the page boundaries", async () => {
    const doc = await docs.scrape({ url: at("text3.pdf"), parsers: [{ type: "pdf", pages: true, pageMarkers: true }] });
    expect(doc.pages?.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(doc.pages?.[1]?.markdown).toContain("Text page 2");
    expect(doc.markdown).toBe(marked("## "));
    expect(doc.warning).toBeUndefined();
  });

  test("pages and pageMarkers respect maxPages; neither is set unless asked for", async () => {
    const limited = await docs.scrape({ url: at("text3.pdf"), parsers: [{ type: "pdf", maxPages: 2, pages: true, pageMarkers: true }] });
    expect(limited.pages?.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(limited.markdown).not.toContain("Text page 3");
    const plainDoc = await docs.scrape({ url: at("text3.pdf") });
    expect(plainDoc.pages).toBeUndefined();
    expect(plainDoc.markdown).not.toContain("<!-- page");
  });

  test("html and rawHtml of a converted document are its Markdown rendered", async () => {
    const doc = await docs.scrape({ url: at("report.docx"), formats: ["markdown", "html", "rawHtml"] });
    expect(doc.html).toContain("<strong>12%</strong>");
    expect(doc.html).toContain("<table>");
    expect(doc.rawHtml).toBe(doc.html);
  });

  test("text/csv goes through here-docs as a table", async () => {
    const doc = await docs.scrape({ url: at("data.csv") });
    expect(doc.markdown).toContain("| widget | 4 |");
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

  test("time spent waiting for a conversion slot counts against the deadline", async () => {
    const one = new DocsConverter({ ...docs.config, docsConcurrency: 1 });
    const bytes = await fixture("scan.pdf").bytes();
    const first = one.convert(bytes, { deadline: Deadline.start(60_000) });
    const err = await rejection(one.convert(bytes, { deadline: Deadline.start(1) }));
    expect({ status: err.status, code: err.code }).toEqual({ status: 408, code: "SCRAPE_TIMEOUT" });
    await first;
    await one.close();
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

/** here-docs stand-in that converts `pages` pages at once, then hangs until the signal aborts, like a conversion that runs out of time. */
function stalledHereDocs(pages: number, pageCount: number): HereDocs {
  return {
    createEngine: async () => ({ close: async () => {} }),
    async *convertPages(_bytes: Uint8Array, opts: { signal?: AbortSignal }) {
      for (let page = 1; page <= pages; page++) yield { page, pageCount, markdown: `page ${page}`, warnings: [] };
      await new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true }));
    },
  } as unknown as HereDocs;
}

describe("a conversion that runs out of time", () => {
  const converter = (hereDocs: HereDocs) => new DocsConverter({ ...plain.config, docs: true }, async () => hereDocs);

  test("returns the pages converted so far, with a warning", async () => {
    const c = converter(stalledHereDocs(2, 5));
    const doc = await c.convert(new Uint8Array([1]), { deadline: Deadline.start(100) });
    expect(doc.markdown).toBe("page 1\n\npage 2");
    expect({ numPages: doc.numPages, pagesConverted: doc.pagesConverted }).toEqual({ numPages: 5, pagesConverted: 2 });
    expect(doc.warnings).toEqual([{ code: "timeout", message: "Timed out: converted only the first 2 of 5 pages" }]);
    await c.close();
  });

  test("with no page converted is a 408 SCRAPE_TIMEOUT", async () => {
    const c = converter(stalledHereDocs(0, 5));
    const err = await rejection(c.convert(new Uint8Array([1]), { deadline: Deadline.start(100) }));
    expect({ status: err.status, code: err.code }).toEqual({ status: 408, code: "SCRAPE_TIMEOUT" });
    await c.close();
  });
});

describe("without SEX_DOCS", () => {
  test("PDFs fall back to unpdf, which honours maxPages too", async () => {
    const doc = await plain.scrape({ url: at("text3.pdf"), parsers: [{ type: "pdf", maxPages: 2 }] });
    expect(doc.markdown).toContain("Text page 2");
    expect(doc.markdown).not.toContain("Text page 3");
    expect(doc.metadata?.numPages).toBe(2);
    expect(doc.metadata?.totalPages).toBe(3);
    expect(doc.warning).toContain("first 2 of 3 pages");
  });

  test("parsers pages returns each page, pageMarkers marks the page boundaries", async () => {
    const doc = await plain.scrape({ url: at("text3.pdf"), parsers: [{ type: "pdf", pages: true, pageMarkers: true }] });
    expect(doc.pages).toEqual([1, 2, 3].map((n) => ({ pageNumber: n, markdown: `Text page ${n}` })));
    expect(doc.markdown).toBe(marked());
    expect(doc.warning).toBeUndefined();
  });

  test("pageMarkdown is an alias of pages; pages and pageMarkers are not reported as ignored", async () => {
    const doc = await plain.scrape({ url: at("text3.pdf"), parsers: [{ type: "pdf", pageMarkdown: true }] });
    expect(doc.pages).toHaveLength(3);
    expect(doc.markdown).toContain("---");
    expect(doc.markdown).not.toContain("<!-- page");
    expect(doc.warning).toBeUndefined();
  });

  test("pages are left out unless asked for, and mode is still reported as ignored", async () => {
    const doc = await plain.scrape({ url: at("text3.pdf"), parsers: [{ type: "pdf", mode: "ocr" }] });
    expect(doc.pages).toBeUndefined();
    expect(doc.warning).toContain("mode");
  });

  test("without maxPages numPages and totalPages are the page count", async () => {
    const doc = await plain.scrape({ url: at("text3.pdf") });
    expect({ numPages: doc.metadata?.numPages, totalPages: doc.metadata?.totalPages }).toEqual({ numPages: 3, totalPages: 3 });
    expect(doc.warning).toBeUndefined();
  });

  test("html and rawHtml of a PDF are its Markdown rendered, raw HTML in the text escaped", async () => {
    const doc = await plain.scrape({ url: at("text3.pdf"), formats: ["html", "rawHtml"] });
    expect(doc.html).toContain("<p>Text page 1</p>");
    expect(doc.html).toContain("<hr");
    expect(doc.rawHtml).toBe(doc.html);
    expect(markdownToHtml("<script>alert(1)</script> and <img src=x onerror=y>")).not.toContain("<script");
  });

  test("a PDF is returned as base64 when the parsers list leaves out pdf", async () => {
    const doc = await plain.scrape({ url: at("text3.pdf"), formats: ["markdown", "html"], parsers: ["image"] });
    expect(
      Buffer.from(doc.markdown ?? "", "base64")
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    expect(doc.html).toBe(doc.markdown);
    expect(doc.metadata?.contentType).toBe("application/pdf");
    expect(doc.warning).toContain("parsers");
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
