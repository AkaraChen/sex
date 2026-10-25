import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/core/engine.ts";
import { testEngine } from "./helpers.ts";

// Opt-in: needs a CDP browser, e.g. SEX_TEST_CDP_URL=http://127.0.0.1:9333 bun test test/browser.test.ts
const CDP = process.env.SEX_TEST_CDP_URL;

const html = (body: string) =>
  `<!doctype html><html lang="en"><head><title>Browser Fixture</title></head><body><main><article>${body}</article></main></body></html>`;

describe.skipIf(!CDP)("browser", () => {
  let a: ReturnType<typeof Bun.serve>;
  let b: ReturnType<typeof Bun.serve>;
  let bHits: string[] = [];
  let engine: Engine;
  const origin = () => `http://127.0.0.1:${a.port}`;
  const guardA = async (u: string) => new URL(u).port === String(a.port);
  const extract = { onlyMainContent: true, removeBase64Images: true, wantLinks: false, wantImages: false };

  beforeAll(() => {
    // Server B stands in for an internal address: every hit is recorded.
    b = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        bHits.push(new URL(req.url).pathname);
        if (new URL(req.url).pathname === "/pixel.png")
          return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
        return new Response(html("<p>secret internal text</p>"), { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    a = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        switch (pathname) {
          case "/page":
            return new Response(html(`<h1>Fixture heading</h1><p>Hello from the browser fixture.</p><a href="/other">Other page</a>`), {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          case "/other":
            return new Response(html("<p>other</p>"), { headers: { "content-type": "text/html; charset=utf-8" } });
          case "/redirect":
            return Response.redirect(`http://127.0.0.1:${b.port}/secret`, 302);
          case "/img":
            return new Response(html(`<p>Image page</p><img src="http://127.0.0.1:${b.port}/pixel.png">`), {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          default:
            return new Response("not found", { status: 404 });
        }
      },
    });
    engine = testEngine({ cdpUrl: CDP });
  });

  afterAll(async () => {
    await engine?.browser.close();
    a?.stop(true);
    b?.stop(true);
  });

  test("scrapes a page through the browser into markdown and links", async () => {
    const doc = await engine.scrape({ url: `${origin()}/page`, formats: ["markdown", "links"] });
    expect(doc.markdown).toContain("Hello from the browser fixture");
    expect(doc.links).toContain(`${origin()}/other`);
  });

  test("runs actions: javascript return values and page html snapshots", async () => {
    const doc = await engine.scrape({
      url: `${origin()}/page`,
      formats: ["markdown"],
      actions: [{ type: "executeJavascript", script: "return document.title" }, { type: "scrape" }],
    });
    expect(doc.actions?.javascriptReturns[0]?.value).toBe("Browser Fixture");
    expect(doc.actions?.scrapes[0]?.html).toContain("<html");
  });

  test("blocks a redirect to a non-allowed address before its content is fetched", async () => {
    const err = await engine.browser
      .scrape({ url: `${origin()}/redirect`, timeout: 10_000, userAgent: "t", extract, requestGuard: guardA })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("PRIVATE_NETWORK_BLOCKED");
    expect(bHits).toEqual([]);
  });

  test("blocks subresources to a non-allowed address without failing the page", async () => {
    bHits = [];
    const result = await engine.browser.scrape({
      url: `${origin()}/img`,
      timeout: 10_000,
      userAgent: "t",
      extract,
      requestGuard: guardA,
    });
    expect(result.rawHtml).toContain("Image page");
    expect(bHits).toEqual([]);
  });
});
