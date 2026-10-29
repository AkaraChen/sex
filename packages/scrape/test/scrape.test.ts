import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { type DocsResult, type ScrapeDocs, scrapeUpload, scrapeUrl } from "@searxng-js/sex-scrape";
import { html, scrapeContext, serve } from "./support.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="About ${title}"></head>` +
  `<body><nav><a href="/">Home</a></nav><main><article><h1>${title}</h1>${body}</article></main><footer>footer text</footer></body></html>`;
const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );
const outcome = (err: unknown) => ({ status: (err as { status?: number }).status, code: (err as { code?: string }).code });

describe("scrapeUrl on a plain context (no browser, LLM, documents or cache)", async () => {
  const site = await serve((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://x");
    if (pathname === "/nav-only") return html(res, `<html><body><nav><p>${words(40)}</p></nav></body></html>`);
    if (pathname === "/pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.4");
    if (pathname === "/slow") return void setTimeout(() => html(res, page("Slow", "<p>late</p>")), 2_000);
    html(res, page("Home", `<p>${words(60)}</p><a href="/docs/a">Doc A</a>`));
  });
  const ctx = scrapeContext();
  after(async () => {
    await ctx.close();
    await site.close();
  });

  test("returns markdown, metadata and links", async () => {
    const { document } = await scrapeUrl(ctx, `${site.url}/`, { formats: ["markdown", "links"] });
    assert.ok(document.markdown?.startsWith("# Home"));
    assert.equal(document.metadata?.title, "Home");
    assert.equal(document.metadata?.statusCode, 200);
    assert.equal(document.metadata?.cacheState, "miss");
    assert.ok(document.links?.includes(`${site.url}/docs/a`));
  });

  test("the extraction's notes become the document's warning", async () => {
    const { document } = await scrapeUrl(ctx, `${site.url}/nav-only`);
    assert.ok(document.markdown?.includes("word39"));
    assert.equal(document.warning, "No main content was detected on the page, so the whole body was converted.");
  });

  test("an upload is converted like a fetched page and named by its file", async () => {
    const file = new File([page("Uploaded", `<p>${words(60)}</p>`)], "u.html", { type: "text/html" });
    const { document } = await scrapeUpload(ctx, file);
    assert.ok(document.markdown?.startsWith("# Uploaded"));
    assert.equal(document.metadata?.sourceURL, "u.html");
  });

  test("what needs a capability the context lacks is refused with the hint the context gives", async () => {
    const hinted = scrapeContext({}, {}, { missingHints: { browser: "run the other product", llm: "set a model" } });
    try {
      assert.deepEqual(outcome(await caught(scrapeUrl(hinted, `${site.url}/`, { actions: [{ type: "wait", milliseconds: 10 }] }))), {
        status: 501,
        code: "BROWSER_NOT_CONFIGURED",
      });
      assert.match(String(await caught(scrapeUrl(hinted, `${site.url}/`, { formats: ["summary"] }))), /set a model/);
      assert.deepEqual(outcome(await caught(scrapeUrl(hinted, `${site.url}/`, { lockdown: true }))), {
        status: 404,
        code: "SCRAPE_NO_CACHED_DATA",
      });
    } finally {
      await hinted.close();
    }
  });

  test("the private network is refused unless the context allows it", async () => {
    const strict = scrapeContext({}, { allowPrivateNetwork: false });
    try {
      assert.equal(outcome(await caught(scrapeUrl(strict, `${site.url}/`))).code, "PRIVATE_NETWORK_BLOCKED");
    } finally {
      await strict.close();
    }
  });

  test("the request's timeout is the scrape's: SCRAPE_TIMEOUT when the page is too slow", async () => {
    const err = await caught(scrapeUrl(ctx, `${site.url}/slow`, { timeout: 1000 }));
    assert.deepEqual(outcome(err), { status: 408, code: "SCRAPE_TIMEOUT" });
    assert.match((err as Error).message, /^Timed out after 1000ms/);
  });

  test("a time handed in as a signal and deadlineAt bounds the scrape; a cancel is TIMEOUT", async () => {
    const late = await caught(scrapeUrl(ctx, `${site.url}/slow`, {}, { signal: AbortSignal.timeout(300), deadlineAt: Date.now() + 300 }));
    assert.deepEqual(outcome(late), { status: 408, code: "SCRAPE_TIMEOUT" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const cancelled = await caught(scrapeUrl(ctx, `${site.url}/slow`, {}, { signal: controller.signal }));
    assert.deepEqual(outcome(cancelled), { status: 408, code: "TIMEOUT" });
    assert.match((cancelled as Error).message, /^Request cancelled/);
  });

  describe("partial document conversions", () => {
    const scrapeWith = async (result: DocsResult, maxPages?: number) => {
      const docs: ScrapeDocs = { enabled: true, convert: async () => result };
      const withDocs = scrapeContext({ docs });
      try {
        const parsers = maxPages === undefined ? undefined : [{ type: "pdf" as const, maxPages }];
        return (await scrapeUrl(withDocs, `${site.url}/pdf`, { parsers })).document.warning;
      } finally {
        await withDocs.close();
      }
    };

    test("maxPages stopping the conversion is reported", async () => {
      const warning = await scrapeWith({ markdown: "x", numPages: 10, pagesConverted: 3, warnings: [] }, 3);
      assert.equal(warning, "Converted the first 3 of 10 pages (parsers maxPages)");
    });

    test("a timeout's partial result has only the docs warning", async () => {
      const timeout = { code: "timeout", message: "Timed out: converted only the first 2 of 10 pages" };
      // Without maxPages, and with a maxPages the conversion did not reach.
      assert.equal(await scrapeWith({ markdown: "x", numPages: 10, pagesConverted: 2, warnings: [timeout] }), timeout.message);
      assert.equal(await scrapeWith({ markdown: "x", numPages: 10, pagesConverted: 2, warnings: [timeout] }, 5), timeout.message);
    });

    test("a document shorter than maxPages has no warning", async () => {
      assert.equal(await scrapeWith({ markdown: "x", numPages: 2, pagesConverted: 2, warnings: [] }, 5), undefined);
    });

    test("the converter gets the time the scrape has left as a signal and deadlineAt", async () => {
      let seen: { signal?: AbortSignal; deadlineAt?: number } | undefined;
      const docs: ScrapeDocs = {
        enabled: true,
        convert: async (_body, opts) => {
          seen = opts;
          return { markdown: "x", warnings: [] };
        },
      };
      const withDocs = scrapeContext({ docs });
      try {
        const before = Date.now();
        await scrapeUrl(withDocs, `${site.url}/pdf`, { timeout: 5000 });
        assert.ok(seen?.signal instanceof AbortSignal);
        assert.ok(seen.deadlineAt !== undefined && seen.deadlineAt >= before + 4000 && seen.deadlineAt <= before + 5500);
      } finally {
        await withDocs.close();
      }
    });
  });
});
