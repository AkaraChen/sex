import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchBackendError } from "@searxng-js/sex-search";
import type { Config } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { createApp } from "../src/http.ts";
import { createLogger } from "../src/log.ts";

let sidecar: ReturnType<typeof Bun.serve>;
let searxng: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof createApp>;
let dir: string;
let hereDocs: string;
const scrapeBodies: string[] = [];

/** Stands in for the here-docs CLI: reads stdin, answers its `{ markdown, warnings }` shape. */
const HERE_DOCS = `#!/usr/bin/env bun
const input = await Bun.stdin.text();
const at = process.argv.indexOf("--filename");
const filename = at === -1 ? "upload" : process.argv[at + 1];
console.log(JSON.stringify({
  markdown: \`# doc \${filename} (\${input.length} bytes)\`,
  warnings: [{ code: "ocr", message: "ocr skipped" }],
}));
`;

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sex-app-test-"));
  hereDocs = join(dir, "here-docs");
  await writeFile(hereDocs, HERE_DOCS);
  await chmod(hereDocs, 0o755);

  sidecar = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== "Bearer secret") {
        return Response.json({ success: false, error: "unauthorized" }, { status: 401 });
      }
      if (url.pathname === "/v2/scrape") {
        scrapeBodies.push(await request.text());
        return Response.json({
          success: true,
          data: { markdown: "# hello", metadata: { url: "https://example.com" } },
        });
      }
      if (url.pathname === "/v2/map") return Response.json({ success: true, links: ["https://example.com/a"] });
      if (url.pathname.startsWith("/v2/crawl/"))
        return Response.json({ success: true, id: "c1", status: "scraping", total: 3, completed: 1 });
      if (url.pathname.startsWith("/v2/batch/scrape/"))
        return Response.json({ success: true, id: "b1", status: "scraping" });
      return Response.json({ success: true, id: "c1" });
    },
  });

  searxng = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({
        results: [
          {
            url: "https://a.test/",
            title: "Alpha",
            content: "content",
            category: "general",
            engine: "x",
            engines: ["x"],
            positions: [1],
            score: 1,
            template: "default",
            parsed_url: null,
          },
        ],
      });
    },
  });

  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    logLevel: "error",
    localUrl: sidecar.url.origin,
    localToken: "secret",
    searxngUrl: searxng.url.origin,
    parsePath: hereDocs,
    allowPrivate: false,
    timeoutMs: 2000,
    searchChain: [],
    searchExcluded: [],
    searchKeys: {},
  };
  app = createApp(new Engine(config, createLogger("error")));
});

afterAll(async () => {
  await sidecar.stop(true);
  await searxng.stop(true);
  await rm(dir, { recursive: true, force: true });
});

test("/v2/scrape passes through the Document and warns about dropped options", async () => {
  const response = await post("/v2/scrape", {
    url: "https://example.com",
    formats: ["markdown", "json"],
    actions: [],
    blockAds: true,
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.data.markdown).toBe("# hello");
  expect(body.data.warning).toContain("json");
  expect(body.data.warning).toContain("actions");
  expect(body.data.warning).toContain("blockAds");
  expect(scrapeBodies.at(-1)).toContain('"formats":["markdown"]');
  expect(scrapeBodies.at(-1)).not.toContain("actions");
});

test("/v2/scrape refuses a request without a URL", async () => {
  const response = await post("/v2/scrape", {});
  expect(response.status).toBe(400);
  expect((await response.json()).success).toBe(false);
});

test("a sidecar 401 is our misconfiguration, not the caller's", async () => {
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    logLevel: "error",
    localUrl: sidecar.url.origin,
    localToken: "wrong",
    searxngUrl: searxng.url.origin,
    allowPrivate: false,
    timeoutMs: 2000,
    searchChain: [],
    searchExcluded: [],
    searchKeys: {},
  };
  const misconfigured = createApp(new Engine(config, createLogger("error")));
  const response = await misconfigured.request("/v2/scrape", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com" }),
  });
  expect(response.status).toBe(502);
});

test("/v2/search answers the Firecrawl shape", async () => {
  const response = await post("/v2/search", { query: "alpha" });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.id).toBeTruthy();
  expect(body.creditsUsed).toBe(0);
  expect(body.provider).toBe("searxng");
  expect(body.data.web[0]).toMatchObject({ url: "https://a.test/", position: 1 });
});

test("/v2/map passes the answer through", async () => {
  const response = await post("/v2/map", { url: "https://example.com" });
  expect((await response.json()).links).toEqual(["https://example.com/a"]);
});

test("crawl and batch status pass through by id", async () => {
  const crawl = await app.request("/v2/crawl/c1");
  expect((await crawl.json()).total).toBe(3);
  const batch = await app.request("/v2/batch/scrape/b1");
  expect((await batch.json()).status).toBe("scraping");
});

test("/v2/parse converts the upload through the here-docs subprocess", async () => {
  const form = new FormData();
  form.append("file", new File(["hello"], "a.pdf"));
  const response = await app.request("/v2/parse", { method: "POST", body: form });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.data.markdown).toBe("# doc a.pdf (5 bytes)");
  expect(body.data.warning).toContain("ocr skipped");
  expect(body.data.metadata.sourceURL).toBe("a.pdf");
});

test("/v2/parse without a file is a 400", async () => {
  const response = await app.request("/v2/parse", { method: "POST", body: new FormData() });
  expect(response.status).toBe(400);
});

test("unknown routes are a 404", async () => {
  const response = await app.request("/v2/nope");
  expect(response.status).toBe(404);
});

test("an unreachable firecrawl-local is a 503", async () => {
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    logLevel: "error",
    localUrl: "http://127.0.0.1:9",
    searxngUrl: searxng.url.origin,
    allowPrivate: false,
    timeoutMs: 500,
    searchChain: [],
    searchExcluded: [],
    searchKeys: {},
  };
  const failing = createApp(new Engine(config, createLogger("error")));
  const response = await failing.request("/v2/scrape", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com" }),
  });
  expect(response.status).toBe(503);
});

test("/v2/search maps SearchBackendError statuses onto HTTP responses", async () => {
  const cases: Array<[backendStatus: number, httpStatus: number, code: string]> = [
    [504, 504, "TIMEOUT"],
    [408, 504, "TIMEOUT"],
    [429, 429, "SEARCH_RATE_LIMITED"],
    [503, 503, "SEARCH_UNAVAILABLE"],
    [401, 502, "SEARCH_BACKEND_ERROR"],
    [403, 502, "SEARCH_BACKEND_ERROR"],
    [500, 502, "SEARCH_BACKEND_ERROR"],
  ];

  for (const [backendStatus, httpStatus, code] of cases) {
    const fakeEngine = {
      async search() {
        throw new SearchBackendError(`upstream ${backendStatus}`, backendStatus);
      },
    } as unknown as Engine;
    const testApp = createApp(fakeEngine);
    const response = await testApp.request("/v2/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "alpha" }),
    });
    expect(response.status).toBe(httpStatus);
    expect(await response.json()).toEqual({
      success: false,
      error: `upstream ${backendStatus}`,
      code,
    });
  }
});

test("/v2/search propagates provider rate limit, outage, and hides auth failures as 502", async () => {
  const scenarios: Array<[upstreamStatus: number, httpStatus: number, code: string]> = [
    [429, 429, "SEARCH_RATE_LIMITED"],
    [503, 503, "SEARCH_UNAVAILABLE"],
    [401, 502, "SEARCH_BACKEND_ERROR"],
    [403, 502, "SEARCH_BACKEND_ERROR"],
  ];

  const original = globalThis.fetch;
  try {
    for (const [upstreamStatus, httpStatus, code] of scenarios) {
      globalThis.fetch = (async () =>
        new Response("secret upstream body", { status: upstreamStatus })) as unknown as typeof fetch;
      const config: Config = {
        host: "127.0.0.1",
        port: 0,
        logLevel: "error",
        allowPrivate: false,
        timeoutMs: 2000,
        searchChain: ["tavily"],
        searchExcluded: ["searxng"],
        searchKeys: { tavily: "tvly-secret-test-key" },
      };
      const providerApp = createApp(new Engine(config, createLogger("error")));
      const response = await providerApp.request("/v2/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "alpha" }),
      });
      expect(response.status).toBe(httpStatus);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe(code);
      expect(JSON.stringify(body)).not.toContain("secret upstream body");
      expect(JSON.stringify(body)).not.toContain("tvly-secret-test-key");
    }
  } finally {
    globalThis.fetch = original;
  }
});
