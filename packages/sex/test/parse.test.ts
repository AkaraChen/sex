import { afterAll, describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config.ts";
import { Engine } from "../src/engine/engine.ts";
import { createApp } from "../src/http/server.ts";
import { testEngine, textPdf } from "./helpers.ts";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url));

const docs = testEngine({ docs: true });
const plain = testEngine();
const small = new Engine(
  resolveConfig({ allowPrivateNetwork: true, searxngUrl: "http://127.0.0.1:1" }, undefined, { SEX_MAX_BODY_BYTES: "2048" }),
);
// here-docs ships native engines for a fixed set of hosts; elsewhere the converter tests have nothing to run against.
const available = await docs.docs.warmup().then(
  () => true,
  (err) => {
    console.warn(`skipping here-docs tests: ${(err as Error).message}`);
    return false;
  },
);

afterAll(async () => {
  await Promise.all([docs.close(), plain.close(), small.close()]);
});

/** POST /v2/parse as a browser or curl -F would send it: multipart/form-data with `file` and `options`. */
async function parse(engine: typeof plain, file: Blob | undefined, options?: unknown, filename = "upload") {
  const form = new FormData();
  if (file) form.set("file", file, filename);
  if (options !== undefined) form.set("options", typeof options === "string" ? options : JSON.stringify(options));
  const res = await createApp(engine).app.fetch(new Request("http://sex.test/v2/parse", { method: "POST", body: form }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const pdf = (pages = 3) => new Blob([textPdf(pages)], { type: "application/pdf" });

describe("POST /v2/parse without SEX_DOCS", () => {
  test("a PDF comes back as a document, sourceURL is the file name", async () => {
    const { status, body } = await parse(plain, pdf(), undefined, "report.pdf");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.markdown).toContain("Text page 2");
    expect(body.data.metadata).toMatchObject({ sourceURL: "report.pdf", statusCode: 200, contentType: "application/pdf", numPages: 3 });
  });

  test("options is a JSON string: parsers maxPages, pages and pageMarkers", async () => {
    const options = { parsers: [{ type: "pdf", maxPages: 2, pages: true, pageMarkers: true }] };
    const { status, body } = await parse(plain, pdf(), options);
    expect(status).toBe(200);
    expect(body.data.pages).toEqual([1, 2].map((n) => ({ pageNumber: n, markdown: `Text page ${n}` })));
    expect(body.data.markdown).toBe("Text page 1\n\n---\n\n<!-- page 2 -->\n\nText page 2");
  });

  test("a PDF is recognised by its bytes, not by its name or type", async () => {
    const { status, body } = await parse(plain, new Blob([textPdf(1)]), undefined, "data.bin");
    expect(status).toBe(200);
    expect(body.data.markdown).toContain("Text page 1");
  });

  test("an HTML file is extracted like a page", async () => {
    const html =
      "<html><head><title>Mine</title></head><body><article><h1>Mine</h1><p>An uploaded page with enough words to count as content.</p></article></body></html>";
    const { status, body } = await parse(plain, new Blob([html], { type: "text/html" }), { formats: ["markdown", "html"] }, "page.html");
    expect(status).toBe(200);
    expect(body.data.markdown).toContain("An uploaded page");
    expect(body.data.metadata.title).toBe("Mine");
  });

  test("office documents and images are 415 without the converter", async () => {
    for (const name of ["report.docx", "hello.png"]) {
      const { status, body } = await parse(plain, fixture(name), undefined, name);
      expect({ status, code: body.code }).toEqual({ status: 415, code: "UNSUPPORTED_FILE" });
    }
  });

  test("bad requests are 400s", async () => {
    expect((await parse(plain, undefined)).status).toBe(400);
    const notJson = await parse(plain, pdf(), "{nope");
    expect(notJson.status).toBe(400);
    expect(notJson.body.error).toContain("valid JSON");
    expect((await parse(plain, pdf(), "[]")).status).toBe(400);
    expect((await parse(plain, pdf(), { parsers: ["pfd"] })).status).toBe(400);
    expect((await parse(plain, pdf(), { formats: ["rawBase64"] })).status).toBe(400);
  });

  test("a file over SEX_MAX_BODY_BYTES is a 413", async () => {
    const { status, body } = await parse(small, new Blob([new Uint8Array(4096)]), undefined, "big.bin");
    expect({ status, code: body.code }).toEqual({ status: 413, code: "RESPONSE_TOO_LARGE" });
  });

  test("the API document describes the upload as multipart/form-data", async () => {
    const res = await createApp(plain).app.fetch(new Request("http://sex.test/openapi.json"));
    const spec = (await res.json()) as { paths: Record<string, any> };
    expect(Object.keys(spec.paths["/v2/parse"].post.requestBody.content)).toContain("multipart/form-data");
  });
});

describe.skipIf(!available)("POST /v2/parse with SEX_DOCS", () => {
  test("a Word document is converted", async () => {
    const { status, body } = await parse(docs, fixture("report.docx"), undefined, "report.docx");
    expect(status).toBe(200);
    expect(body.data.markdown.length).toBeGreaterThan(0);
    expect(body.data.metadata.sourceURL).toBe("report.docx");
  });

  test("an image is OCR'd, a scanned PDF too", async () => {
    expect((await parse(docs, fixture("hello.png"), undefined, "hello.png")).body.data.markdown).toContain("HELLO");
    expect((await parse(docs, fixture("scan.pdf"), undefined, "scan.pdf")).body.data.markdown).toContain("Scanned invoice 4711");
  });

  test("pages and pageMarkers on the here-docs path", async () => {
    const { body } = await parse(docs, pdf(), { parsers: [{ type: "pdf", pages: true, pageMarkers: true }] });
    expect(body.data.pages.map((p: { pageNumber: number }) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(body.data.markdown).toContain("---\n\n<!-- page 3 -->\n\n");
  });

  test("a name-only CSV (no content type) goes by its extension", async () => {
    const { status, body } = await parse(docs, new Blob(["name,qty\nwidget,4\n"]), undefined, "data.csv");
    expect(status).toBe(200);
    expect(body.data.markdown).toContain("widget");
  });
});
