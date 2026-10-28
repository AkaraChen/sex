import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { Deadline } from "../src/core/deadline.ts";
import type { Engine } from "../src/core/engine.ts";
import { sitemapUrls } from "../src/core/map.ts";
import { testEngine } from "./helpers.ts";

const paragraphs = Array.from(
  { length: 4 },
  (_, i) => `<p>Paragraph ${i + 1} about the site. ${"Lorem ipsum dolor sit amet. ".repeat(8)}</p>`,
).join("");

let bomb: ReturnType<typeof Bun.serve>;
let small: ReturnType<typeof Bun.serve>;
let bombBase: string;
let smallBase: string;
let engine: Engine;

beforeAll(() => {
  bomb = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      switch (pathname) {
        case "/":
          return new Response(
            `<!doctype html><html lang="en"><head><title>Home</title></head><body><main><article><h1>Home</h1>${paragraphs}<a href="/a%zz">bad</a> <a href="/ok-page">ok</a> <a href="/sale-50%-off">sale</a></article></main></body></html>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        case "/sitemap.xml":
          return new Response(gzipSync(Buffer.alloc(30 * 1024 * 1024, 0x20)), {
            headers: { "content-type": "application/x-gzip" },
          });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  bombBase = `http://127.0.0.1:${bomb.port}`;

  small = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/sitemap.xml") {
        const xml = `<?xml version="1.0"?><urlset><url><loc>${url.origin}/from-sitemap</loc></url></urlset>`;
        return new Response(gzipSync(Buffer.from(xml)), { headers: { "content-type": "application/x-gzip" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  smallBase = `http://127.0.0.1:${small.port}`;

  engine = testEngine({ searxngUrl: "http://127.0.0.1:1" });
});

afterAll(async () => {
  bomb.stop(true);
  small.stop(true);
  await engine.close();
});

describe("map hardening", () => {
  test("map with search survives malformed percent escapes", async () => {
    const ok = await engine.map({ url: bombBase, search: "ok" });
    expect(ok.map((l) => l.url)).toContain(`${bombBase}/ok-page`);
    const bad = await engine.map({ url: bombBase, search: "zz" });
    expect(bad.map((l) => l.url)).toContain(`${bombBase}/a%zz`);
  });

  test("gzip sitemap inflation is capped instead of exhausting memory", async () => {
    await expect(sitemapUrls(engine, bombBase, 10, Deadline.unbounded())).resolves.toEqual([]);
  });

  test("a small gzipped sitemap is still parsed", async () => {
    await expect(sitemapUrls(engine, smallBase, 10, Deadline.unbounded())).resolves.toEqual([`${smallBase}/from-sitemap`]);
  });
});
