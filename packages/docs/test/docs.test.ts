import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DocsConverter, type HereDocs } from "@searxng-js/sex-docs";
import { AppError } from "@searxng-js/sex-errors";

async function rejection(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await p;
  } catch (err) {
    if (AppError.isInstance(err)) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error("expected rejection");
}

/** A deadline `ms` from now, the way a caller of the package gives it: a signal and the epoch ms it ends at. */
const within = (ms: number) => ({ signal: AbortSignal.timeout(ms), deadlineAt: Date.now() + ms });

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

/** here-docs stand-in that answers with the given parts at once. */
function fixedHereDocs(
  parts: Array<{ page: number | null; pageCount?: number; markdown: string; warnings?: Array<{ code: string; message: string }> }>,
): HereDocs {
  return {
    createEngine: async () => ({ close: async () => {} }),
    async *convertPages() {
      for (const part of parts) yield { warnings: [], ...part };
    },
  } as unknown as HereDocs;
}

const converter = (hereDocs: HereDocs, concurrency = 2) => new DocsConverter({ enabled: true, concurrency }, async () => hereDocs);

describe("a conversion that runs out of time", () => {
  test("returns the pages converted so far, with a warning", async () => {
    const c = converter(stalledHereDocs(2, 5));
    const doc = await c.convert(new Uint8Array([1]), within(100));
    assert.equal(doc.markdown, "page 1\n\npage 2");
    assert.deepEqual({ numPages: doc.numPages, pagesConverted: doc.pagesConverted }, { numPages: 5, pagesConverted: 2 });
    assert.deepEqual(doc.warnings, [{ code: "timeout", message: "Timed out: converted only the first 2 of 5 pages" }]);
    await c.close();
  });

  test("with no page converted is a 408 SCRAPE_TIMEOUT", async () => {
    const c = converter(stalledHereDocs(0, 5));
    assert.deepEqual(await rejection(c.convert(new Uint8Array([1]), within(100))), { status: 408, code: "SCRAPE_TIMEOUT" });
    await c.close();
  });

  test("a cancelled request is a 408 TIMEOUT", async () => {
    const c = converter(stalledHereDocs(0, 5));
    const caller = new AbortController();
    const pending = rejection(c.convert(new Uint8Array([1]), { signal: caller.signal }));
    setTimeout(() => caller.abort(), 20);
    assert.deepEqual(await pending, { status: 408, code: "TIMEOUT" });
    await c.close();
  });

  test("time spent waiting for a conversion slot counts against the deadline", async () => {
    const c = converter(stalledHereDocs(0, 5), 1);
    const first = c.convert(new Uint8Array([1]), within(300)).catch(() => {});
    assert.deepEqual(await rejection(c.convert(new Uint8Array([1]), within(20))), { status: 408, code: "SCRAPE_TIMEOUT" });
    await first;
    await c.close();
  });
});

describe("what a conversion returns", () => {
  test("pages in order, maxPages stops early", async () => {
    const c = converter(
      fixedHereDocs([
        { page: 1, pageCount: 3, markdown: "one" },
        { page: 2, pageCount: 3, markdown: "two" },
        { page: 3, pageCount: 3, markdown: "three" },
      ]),
    );
    const doc = await c.convert(new Uint8Array([1]), { maxPages: 2 });
    assert.equal(doc.markdown, "one\n\ntwo");
    assert.deepEqual(doc.pages, [
      { pageNumber: 1, markdown: "one" },
      { pageNumber: 2, markdown: "two" },
    ]);
    assert.deepEqual({ numPages: doc.numPages, pagesConverted: doc.pagesConverted }, { numPages: 3, pagesConverted: 2 });
    await c.close();
  });

  test("text that belongs to no page leaves pages out", async () => {
    const c = converter(fixedHereDocs([{ page: null, markdown: "a sheet" }]));
    const doc = await c.convert(new Uint8Array([1]), {});
    assert.equal(doc.markdown, "a sheet");
    assert.equal(doc.pages, undefined);
    await c.close();
  });

  test("nothing readable is a 415 or a 422 by the converter's warning", async () => {
    const unknown = converter(fixedHereDocs([{ page: null, markdown: "", warnings: [{ code: "unknown-type", message: "no" }] }]));
    assert.deepEqual(await rejection(unknown.convert(new Uint8Array([1]), {})), { status: 415, code: "UNSUPPORTED_FILE" });
    const broken = converter(fixedHereDocs([{ page: null, markdown: "", warnings: [{ code: "encrypted", message: "locked" }] }]));
    const err = await rejection(broken.convert(new Uint8Array([1]), {}));
    assert.equal(err.code, "DOCUMENT_PARSE_FAILED");
    await unknown.close();
    await broken.close();
  });

  test("a here-docs that cannot be loaded is DOCS_UNAVAILABLE", async () => {
    const c = new DocsConverter({ enabled: true, concurrency: 1 }, async () => {
      throw new Error("not installed");
    });
    assert.deepEqual(await rejection(c.convert(new Uint8Array([1]), {})), { status: 502, code: "DOCS_UNAVAILABLE" });
  });
});

describe("disabled", () => {
  test("is not enabled and never starts", async () => {
    const c = new DocsConverter({ enabled: false, concurrency: 1 });
    assert.equal(c.enabled, false);
    await c.warmup();
    await c.close();
  });
});
