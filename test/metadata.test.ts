import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/core/engine.ts";
import { createApp } from "../src/http/server.ts";
import { testEngine, waitFor } from "./helpers.ts";

const body = (topic: string) =>
  Array.from({ length: 4 }, (_, i) => `<p>Paragraph ${i + 1} about ${topic}. ${"Lorem ipsum dolor sit amet. ".repeat(8)}</p>`).join("");

const page = (head: string, title: string, content: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body><main><article><h1>${title}</h1>${body(content)}</article></main></body></html>`;

// Repeated <meta> tags: a name=description plus a schema.org itemprop=description, and two different titles.
const fixtures: Record<string, string> = {
  "/micro": page(
    '<meta name="description" content="Plain description"><meta itemprop="description" content="Microdata description">',
    "Micro",
    "micro",
  ),
  "/dup-title": page('<meta name="title" content="First title"><meta name="title" content="Second title">', "Dup", "dup"),
  // No <title> element at all; two different meta titles must not be comma-joined into metadata.title.
  "/no-title-tag": `<!doctype html><html lang="en"><head><meta name="title" content="A"><meta name="title" content="B"></head><body><main><article><h1>Heading</h1>${body("no title tag")}</article></main></body></html>`,
};

let server: ReturnType<typeof Bun.serve>;
let base: string;
let engine: Engine;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      const html = fixtures[pathname];
      if (html) return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n");
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  engine = testEngine();
});

afterAll(async () => {
  await engine.close();
  server.stop(true);
});

describe("metadata arrays", () => {
  const call = async (method: string, path: string, reqBody?: unknown) => {
    const app = createApp(engine);
    const res = await app.fetch(
      new Request(`http://sex.test${path}`, {
        method,
        headers: reqBody ? { "content-type": "application/json" } : {},
        body: reqBody ? JSON.stringify(reqBody) : undefined,
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  test("repeated description meta tags yield a string description on scrape", async () => {
    const { status, body } = await call("POST", "/v2/scrape", { url: `${base}/micro`, formats: ["markdown"] });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.metadata.description).toBe("Plain description");
  });

  test("repeated title meta tags keep metadata.title a string on scrape", async () => {
    const { status, body } = await call("POST", "/v2/scrape", { url: `${base}/dup-title`, formats: ["markdown"] });
    expect(status).toBe(200);
    expect(typeof body.data.metadata.title).toBe("string");
  });

  test("without a <title> element, repeated meta titles yield the first value, not a joined array", async () => {
    const { status, body } = await call("POST", "/v2/scrape", { url: `${base}/no-title-tag`, formats: ["markdown"] });
    expect(status).toBe(200);
    expect(body.data.metadata.title).toBe("A");
  });

  test("crawl of a page with repeated meta tags completes and status is 200", async () => {
    const started = await engine.crawl({ url: `${base}/micro`, limit: 1, sitemap: "skip" });
    const id = started.id;
    const status = await waitFor(async () => {
      const res = await call("GET", `/v2/crawl/${id}`);
      expect(res.status).toBe(200);
      return res.body.status === "completed" ? res.body : undefined;
    });
    expect(status.data).toHaveLength(1);
    expect(status.data[0].metadata.description).toBe("Plain description");
  });
});
