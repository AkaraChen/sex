import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bin } from "../lib/bin.ts";
import { api, killAll, type Server, serve, until } from "../lib/proc.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { mockSearx, pagesSite } from "./support.ts";

const lite = bin("sex-lite");
const pages = pagesSite();
const searx = mockSearx(() => [
  { url: `${pages.url}/article`, title: "Article", content: "the article" },
  { url: `${pages.url}/gone`, title: "Gone", content: "a 404 page" },
  { url: "https://github.com/o/r", title: "Repo", content: "a repository" },
]);
let s: Server;

beforeAll(async () => {
  s = await serve(lite, ["--allow-private-network"], { env: { SEX_SEARXNG_URL: searx.url } });
});
afterAll(async () => {
  await s.stop();
  pages.stop();
  searx.stop();
  await killAll();
  removeTempDirs();
});

const scrape = (body: unknown, base = s.url) => api(base, "/v2/scrape", { body });
const search = (body: unknown, base = s.url) => api(base, "/v2/search", { body });

describe("meta endpoints", () => {
  test("GET /health: status, version and the SearXNG it uses", async () => {
    const r = await api(s.url, "/health");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("json");
    expect(r.body.status).toBe("ok");
    expect(r.body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.body.searxng).toBe(searx.url);
    // sex-lite has no browser, LLM or job store to report.
    for (const k of ["browser", "llm", "jobs", "documents"]) expect(r.body[k], k).toBeUndefined();
  });

  test("GET /docs is the HTML API reference", async () => {
    const r = await api(s.url, "/docs");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.body).toContain("sex-lite API");
    expect(r.body).toContain("Scrape a single URL");
    // The root serves the same reference.
    expect((await api(s.url, "/")).body).toContain("sex-lite API");
  });

  test("GET /openapi.json is an OpenAPI 3 document with exactly the two lite operations", async () => {
    const r = await api(s.url, "/openapi.json");
    expect(r.status).toBe(200);
    expect(r.body.openapi).toMatch(/^3\.\d/);
    expect(r.body.info.title).toBe("sex-lite");
    expect(Object.keys(r.body.paths).sort()).toEqual(["/v2/scrape", "/v2/search"]);
    for (const path of ["/v2/scrape", "/v2/search"]) {
      const op = r.body.paths[path].post;
      expect(op, path).toBeDefined();
      expect(op.requestBody.content["application/json"].schema, path).toBeDefined();
      expect(Object.keys(op.responses).length, path).toBeGreaterThan(0);
    }
    const scrapeProps = r.body.paths["/v2/scrape"].post.requestBody.content["application/json"].schema.properties;
    expect(Object.keys(scrapeProps)).toEqual(expect.arrayContaining(["url", "formats", "onlyMainContent", "timeout"]));
    // It must be valid JSON all the way down: re-serialising loses nothing.
    expect(JSON.parse(JSON.stringify(r.body))).toEqual(r.body);
  });

  test("API responses carry an x-request-id that is in the access log on stderr", async () => {
    const r = await scrape({ url: `${pages.url}/plain` });
    const id = r.headers.get("x-request-id");
    expect(id).toBeTruthy();
    await until(() => (s.stderr().includes(`rid=${id}`) ? true : undefined), 5000);
    expect(s.stderr()).toMatch(new RegExp(`INFO http method=POST path=/v2/scrape status=200 ms=\\d+ rid=${id}`));
  });

  test("a request id sent by the caller is echoed", async () => {
    const r = await api(s.url, "/v2/scrape", { body: { url: `${pages.url}/plain` }, headers: { "x-request-id": "e2e-request-1" } });
    expect(r.headers.get("x-request-id")).toBe("e2e-request-1");
  });
});

describe("POST /v2/scrape", () => {
  test("success: {success: true, data: Document} with markdown by default", async () => {
    const r = await scrape({ url: `${pages.url}/article` });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.markdown).toContain("Heading One");
    expect(r.body.data.metadata).toMatchObject({ statusCode: 200, sourceURL: `${pages.url}/article`, title: "Test Article" });
  });

  test("every supported format in one request", async () => {
    const r = await scrape({ url: `${pages.url}/article`, formats: ["markdown", "html", "rawHtml", "links", "images"] });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.markdown).toContain("Heading One");
    expect(d.html).toContain("Heading One");
    expect(d.rawHtml).toContain("<nav");
    expect(d.links).toContain(`${pages.url}/other`);
    expect(d.images).toContain(`${pages.url}/img/one.png`);
  });

  test("object-form formats work: {type: 'markdown'}", async () => {
    const r = await scrape({ url: `${pages.url}/article`, formats: [{ type: "markdown" }] });
    expect(r.status).toBe(200);
    expect(r.body.data.markdown).toContain("Heading One");
  });

  test("onlyMainContent false, includeTags, excludeTags and headers", async () => {
    const full = await scrape({ url: `${pages.url}/article`, onlyMainContent: false });
    expect(full.body.data.markdown).toContain("FOOTER-TEXT");
    const main = await scrape({ url: `${pages.url}/article` });
    expect(main.body.data.markdown).not.toContain("FOOTER-TEXT");
    const inc = await scrape({ url: `${pages.url}/article`, includeTags: [".side"] });
    expect(inc.body.data.markdown.trim()).toBe("SIDEBAR-TEXT");
    const exc = await scrape({ url: `${pages.url}/article`, onlyMainContent: false, excludeTags: [".side", ".ad-slot"] });
    expect(exc.body.data.markdown).not.toContain("SIDEBAR-TEXT");
    expect(exc.body.data.markdown).not.toContain("AD-SLOT-TEXT");
    const h = await scrape({ url: `${pages.url}/echo-headers`, headers: { "X-Test": "via-api" } });
    expect(h.body.data.markdown).toContain("via-api");
  });

  test("a 404 target is a 200 response with metadata.statusCode 404", async () => {
    const r = await scrape({ url: `${pages.url}/gone` });
    expect(r.status).toBe(200);
    expect(r.body.data.metadata.statusCode).toBe(404);
  });

  test("a per-request timeout cuts a slow page: 408 SCRAPE_TIMEOUT, retryable", async () => {
    const r = await scrape({ url: `${pages.url}/slow?ms=20000`, timeout: 1000 });
    expect(r.status).toBe(408);
    expect(r.body).toMatchObject({ success: false, code: "SCRAPE_TIMEOUT", retryable: true });
  });

  test("RESPONSE_TOO_LARGE is 413, a redirect loop 508, a refused connection 500 SCRAPE_SITE_ERROR", async () => {
    const big = await serve(lite, ["--allow-private-network"], { env: { SEX_MAX_BODY_BYTES: "100000", SEX_SEARXNG_URL: searx.url } });
    try {
      const r = await scrape({ url: `${pages.url}/huge` }, big.url);
      expect(r.status).toBe(413);
      expect(r.body.code).toBe("RESPONSE_TOO_LARGE");
    } finally {
      await big.stop();
    }
    const loop = await scrape({ url: `${pages.url}/redirect-loop` });
    expect(loop.status).toBe(508);
    expect(loop.body.code).toBe("TOO_MANY_REDIRECTS");
    const dead = await scrape({ url: "http://127.0.0.1:1/" });
    expect(dead.status).toBe(500);
    expect(dead.body).toMatchObject({ code: "SCRAPE_SITE_ERROR", retryable: true });
  });

  test("PDFs: a text PDF is parsed and parsers.maxPages stops early", async () => {
    const pdf = await scrape({ url: `${pages.url}/text-pdf` });
    expect(pdf.status).toBe(200);
    expect(pdf.body.data.markdown).toContain("Text page 2");
    const parsers = await scrape({ url: `${pages.url}/text-pdf`, parsers: [{ type: "pdf", maxPages: 1 }] });
    expect(parsers.body.data.markdown).toContain("Text page 1");
    expect(parsers.body.data.markdown).not.toContain("Text page 2");
    expect(parsers.body.data.metadata.numPages).toBe(1);
    expect(parsers.body.data.metadata.totalPages).toBe(2);
  });

  describe("options sex-lite cannot honour are refused or reported, never dropped", () => {
    const url = () => `${pages.url}/article`;
    test("json / summary / query formats: 501 LLM_NOT_CONFIGURED, hint names sex", async () => {
      for (const formats of [["json"], ["summary"], [{ type: "json", prompt: "x" }], [{ type: "query", prompt: "x" }]]) {
        const r = await scrape({ url: url(), formats });
        expect(r.status, JSON.stringify(formats)).toBe(501);
        expect(r.body.code, JSON.stringify(formats)).toMatch(/LLM_NOT_CONFIGURED|BAD_REQUEST/);
        if (r.status === 501) expect(r.body.error).toContain("sex");
      }
    });

    test("actions: 501 BROWSER_NOT_CONFIGURED naming sex", async () => {
      const r = await scrape({ url: url(), actions: [{ type: "wait", milliseconds: 10 }] });
      expect(r.status).toBe(501);
      expect(r.body.code).toBe("BROWSER_NOT_CONFIGURED");
      expect(r.body.error).toContain("sex");
    });

    test("screenshot / branding formats: 501 NOT_SUPPORTED", async () => {
      for (const format of ["screenshot", "branding", "audio"]) {
        const r = await scrape({ url: url(), formats: [format] });
        expect([501, 400], format).toContain(r.status);
        expect(r.body.success).toBe(false);
      }
    });

    test("redactPII / zeroDataRetention / onlyCleanContent: 501", async () => {
      for (const opt of ["redactPII", "zeroDataRetention", "onlyCleanContent"]) {
        const r = await scrape({ url: url(), [opt]: true });
        expect(r.status, opt).toBe(501);
        expect(r.body.code, opt).toBe("NOT_SUPPORTED");
      }
    });

    test("lockdown / minAge: 404 SCRAPE_NO_CACHED_DATA, the page is not fetched", async () => {
      pages.hits.length = 0;
      for (const opt of [{ lockdown: true }, { minAge: 1000 }]) {
        const r = await scrape({ url: url(), ...opt });
        expect(r.status, JSON.stringify(opt)).toBe(404);
        expect(r.body.code).toBe("SCRAPE_NO_CACHED_DATA");
      }
      expect(pages.hits).toEqual([]);
    });

    test("maxAge / storeInCache are accepted and do nothing (no cache): every request is fetched", async () => {
      pages.hits.length = 0;
      for (let i = 0; i < 2; i++) {
        const r = await scrape({ url: url(), maxAge: 600000, storeInCache: true });
        expect(r.status).toBe(200);
        expect(r.body.data.metadata.cacheState).not.toBe("hit");
      }
      expect(pages.hits).toEqual(["/article", "/article"]);
    });

    test("rawBase64 returns the bytes; combined with other formats it is a 400", async () => {
      const ok = await scrape({ url: `${pages.url}/plain`, formats: ["rawBase64"] });
      expect(ok.status).toBe(200);
      expect(Buffer.from(ok.body.data.rawBase64, "base64").toString()).toContain("just some plain text");
      const bad = await scrape({ url: `${pages.url}/plain`, formats: ["rawBase64", "markdown"] });
      expect(bad.status).toBe(400);
    });

    test("fastMode with actions is a 400; fastMode alone works", async () => {
      const bad = await scrape({ url: url(), fastMode: true, actions: [{ type: "wait", milliseconds: 10 }] });
      expect(bad.status).toBe(400);
      expect((await scrape({ url: url(), fastMode: true })).status).toBe(200);
    });

    test("proxy: 'enhanced' has no pool: the scrape works and warning says it is partial", async () => {
      const r = await scrape({ url: url(), proxy: "enhanced" });
      expect(r.status).toBe(200);
      expect(r.body.data.warning).toContain("partial");
    });

    test("location.country is reported as ignored", async () => {
      const r = await scrape({ url: url(), location: { country: "DE" } });
      expect(r.status).toBe(200);
      expect(r.body.data.warning).toBeTruthy();
    });

    test("unknown fields are dropped without SEX_STRICT_REQUESTS (the SDK sends origin / integration)", async () => {
      const r = await scrape({ url: url(), origin: "sdk", integration: "e2e", nonsense: 1 });
      expect(r.status).toBe(200);
    });
  });

  describe("bad request bodies are 400 BAD_REQUEST", () => {
    test("missing url, wrong types, bad url", async () => {
      const cases: Array<[unknown, string?]> = [
        [{}, "url"],
        [{ url: 5 }, "url"],
        [{ url: "not a url" }, "Invalid URL"],
        [{ url: "http://" }],
        [{ url: "" }],
        [{ url: "javascript:alert(1)" }],
        [{ url: `${pages.url}/article`, formats: "markdown" }, "formats"],
        [{ url: `${pages.url}/article`, formats: ["nonsense"] }, "formats"],
        [{ url: `${pages.url}/article`, timeout: 5 }, "timeout"],
        [{ url: `${pages.url}/article`, timeout: 10_000_000 }, "timeout"],
        [{ url: `${pages.url}/article`, onlyMainContent: "yes" }, "onlyMainContent"],
        [{ url: `${pages.url}/article`, includeTags: "h1" }, "includeTags"],
        [{ url: `${pages.url}/article`, waitFor: 70_000 }],
        [{ url: `${pages.url}/article`, parsers: ["docx"] }],
        [{ url: `${pages.url}/article`, formats: Array.from({ length: 30 }, () => "markdown") }],
      ];
      for (const [body, mention] of cases) {
        const r = await scrape(body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body.success).toBe(false);
        expect(r.body.code, JSON.stringify(body)).toBe("BAD_REQUEST");
        expect(typeof r.body.error).toBe("string");
        if (mention) expect(r.body.error, JSON.stringify(body)).toContain(mention);
      }
    });

    test("validation errors carry details with the failing path", async () => {
      const r = await scrape({ url: 5 });
      expect(r.body.details[0]).toMatchObject({ path: "url" });
      expect(typeof r.body.details[0].message).toBe("string");
    });

    test("malformed JSON, a JSON array, a bare string and a missing body", async () => {
      for (const raw of ["{bad", "[]", '"x"', "null", ""]) {
        const res = await fetch(`${s.url}/v2/scrape`, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
        expect(res.status, raw).toBe(400);
        const body = (await res.json()) as any;
        expect(body.code, raw).toBe("BAD_REQUEST");
        expect(body.success).toBe(false);
      }
    });

    test("a non-JSON content type is a 400", async () => {
      const res = await fetch(`${s.url}/v2/scrape`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
      expect(res.status).toBe(400);
    });
  });
});

describe("POST /v2/search", () => {
  test("success: id, creditsUsed 0 and data.web with positions", async () => {
    const r = await search({ query: "anything" });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body.creditsUsed).toBe(0);
    expect(r.body.data.web.map((w: any) => w.position)).toEqual([1, 2, 3]);
    expect(r.body.data.web[2].category).toBe("github");
  });

  test("limit defaults to 10 over HTTP and is honoured", async () => {
    const r = await search({ query: "x", limit: 2 });
    expect(r.body.data.web).toHaveLength(2);
  });

  test("scrapeOptions scrapes each result", async () => {
    const r = await search({ query: "x", limit: 2, scrapeOptions: { formats: ["markdown", "links"] } });
    expect(r.status).toBe(200);
    expect(r.body.data.web[0].markdown).toContain("Heading One");
    expect(r.body.data.web[0].links).toBeDefined();
    expect(r.body.data.web[1].metadata.statusCode).toBe(404);
  });

  test("sources news and images come back under their own keys", async () => {
    const r = await search({ query: "x", sources: ["web", "news", "images"], limit: 1 });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data).sort()).toEqual(["images", "news", "web"]);
  });

  test("zeroDataRetention is 501; country / location / odd tbs are reported in warning", async () => {
    const z = await search({ query: "x", zeroDataRetention: true });
    expect(z.status).toBe(501);
    const w = await search({ query: "x", country: "DE", location: "Berlin", tbs: "cdr:1" });
    expect(w.status).toBe(200);
    expect(w.body.warning).toBeTruthy();
  });

  test("bad bodies are 400", async () => {
    const cases: unknown[] = [
      {},
      { query: 5 },
      { query: "" },
      { query: "x", limit: 0 },
      { query: "x", limit: 101 },
      { query: "x", sources: ["bogus"] },
      { query: "x", sources: "web" },
      { query: "x", timeout: 1 },
      { query: "x", includeDomains: ["not a host!"] },
      { query: "x", scrapeOptions: { formats: ["bogus"] } },
    ];
    for (const body of cases) {
      const r = await search(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe("BAD_REQUEST");
    }
  });

  test("SearXNG down is 502 SEARCH_BACKEND_UNAVAILABLE (retryable), SearXNG 500 is 502 SEARCH_BACKEND_ERROR", async () => {
    const down = await serve(lite, [], { env: { SEX_SEARXNG_URL: "http://127.0.0.1:9" } });
    try {
      const r = await search({ query: "x" }, down.url);
      expect(r.status).toBe(502);
      expect(r.body).toMatchObject({ code: "SEARCH_BACKEND_UNAVAILABLE", retryable: true });
    } finally {
      await down.stop();
    }
    const broken = mockSearx(() => new Response("boom", { status: 500 }));
    const b = await serve(lite, [], { env: { SEX_SEARXNG_URL: broken.url } });
    try {
      const r = await search({ query: "x" }, b.url);
      expect(r.status).toBe(502);
      expect(r.body.code).toBe("SEARCH_BACKEND_ERROR");
    } finally {
      await b.stop();
      broken.stop();
    }
  });
});

describe("routes sex-lite does not have", () => {
  test("map, crawl, batch, extract, parse and queue endpoints are 404 NOT_FOUND", async () => {
    const routes: Array<[string, string]> = [
      ["POST", "/v2/map"],
      ["POST", "/v2/crawl"],
      ["GET", "/v2/crawl/abc"],
      ["DELETE", "/v2/crawl/abc"],
      ["GET", "/v2/crawl/active"],
      ["POST", "/v2/crawl/params-preview"],
      ["POST", "/v2/batch/scrape"],
      ["GET", "/v2/batch/scrape/abc"],
      ["POST", "/v2/extract"],
      ["GET", "/v2/extract/abc"],
      ["POST", "/v2/parse"],
      ["GET", "/v2/concurrency-check"],
      ["GET", "/v2/team/queue-status"],
    ];
    for (const [method, path] of routes) {
      const r = await api(s.url, path, { method, body: method === "POST" ? { url: `${pages.url}/article` } : undefined });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.body, `${method} ${path}`).toMatchObject({ success: false, code: "NOT_FOUND" });
      expect(r.body.error).toContain(path);
    }
  });

  test("unknown paths and wrong methods are 404 too, with the JSON error shape", async () => {
    for (const [method, path] of [
      ["GET", "/nothing"],
      ["GET", "/v2/scrape"],
      ["PUT", "/v2/search"],
      ["GET", "/v1/scrape"],
    ] as const) {
      const r = await api(s.url, path, { method });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.body.code).toBe("NOT_FOUND");
    }
  });

  test("the Authorization header is ignored (no auth)", async () => {
    const r = await api(s.url, "/v2/scrape", { body: { url: `${pages.url}/plain` }, headers: { authorization: "Bearer whatever" } });
    expect(r.status).toBe(200);
  });
});

describe("Host / Origin / CORS", () => {
  test("a loopback bind accepts localhost and 127.0.0.1 Hosts and refuses others with 403 HOST_NOT_ALLOWED", async () => {
    expect((await api(s.url, "/health", { headers: { host: "localhost:3002" } })).status).toBe(200);
    expect((await api(s.url, "/health", { headers: { host: "[::1]:3002" } })).status).toBe(200);
    const r = await api(s.url, "/health", { headers: { host: "evil.example" } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ success: false, code: "HOST_NOT_ALLOWED" });
    expect((await api(s.url, "/v2/scrape", { body: { url: `${pages.url}/plain` }, headers: { host: "evil.example" } })).status).toBe(403);
  });

  test("a foreign Origin is 403 ORIGIN_NOT_ALLOWED when CORS is off; no Origin and the same origin pass", async () => {
    const r = await api(s.url, "/v2/scrape", { body: { url: `${pages.url}/plain` }, headers: { origin: "http://evil.example" } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(pages.hits).not.toContain("/plain?evil");
    expect((await api(s.url, "/health", { headers: { origin: s.url } })).status).toBe(200);
    const pre = await fetch(`${s.url}/v2/scrape`, {
      method: "OPTIONS",
      headers: { origin: "http://evil.example", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(403);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("SEX_CORS_ORIGINS allows exactly the listed origins, with a working preflight", async () => {
    const c = await serve(lite, [], { env: { SEX_CORS_ORIGINS: "http://app.test,http://other.test", SEX_SEARXNG_URL: searx.url } });
    try {
      const pre = await fetch(`${c.url}/v2/scrape`, {
        method: "OPTIONS",
        headers: { origin: "http://app.test", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("http://app.test");
      expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
      expect(pre.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");
      const ok = await api(c.url, "/health", { headers: { origin: "http://other.test" } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe("http://other.test");
      const no = await api(c.url, "/health", { headers: { origin: "http://third.test" } });
      expect(no.status).toBe(403);
      expect(no.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await c.stop();
    }
  });

  test("SEX_ALLOWED_HOSTS replaces the localhost default", async () => {
    const c = await serve(lite, [], { env: { SEX_ALLOWED_HOSTS: "sex.test", SEX_SEARXNG_URL: searx.url } });
    try {
      expect((await api(c.url, "/health", { headers: { host: "sex.test" } })).status).toBe(200);
      expect((await api(c.url, "/health", { headers: { host: "sex.test:3002" } })).status).toBe(200);
      const r = await api(c.url, "/health");
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("HOST_NOT_ALLOWED");
    } finally {
      await c.stop();
    }
  });

  test("--allowed-host and --cors-origin flags do the same as the variables", async () => {
    const c = await serve(lite, ["--allowed-host", "flag.test", "--cors-origin", "http://flag-app.test"], {
      env: { SEX_SEARXNG_URL: searx.url },
    });
    try {
      const r = await api(c.url, "/health", { headers: { host: "flag.test", origin: "http://flag-app.test" } });
      expect(r.status).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("http://flag-app.test");
    } finally {
      await c.stop();
    }
  });
});

describe("SEX_STRICT_REQUESTS", () => {
  let strict: Server;
  beforeAll(async () => {
    strict = await serve(lite, ["--allow-private-network"], { env: { SEX_STRICT_REQUESTS: "1", SEX_SEARXNG_URL: searx.url } });
  });
  afterAll(async () => {
    await strict.stop();
  });

  test("undeclared fields are 400 BAD_REQUEST naming the field, nested ones with their path", async () => {
    const top = await scrape({ url: `${pages.url}/plain`, unknownField: 1 }, strict.url);
    expect(top.status).toBe(400);
    expect(top.body.code).toBe("BAD_REQUEST");
    expect(top.body.error).toContain("unknownField");
    expect(top.body.error).toContain("SEX_STRICT_REQUESTS");
    const nested = await search({ query: "x", scrapeOptions: { bogus: 1 } }, strict.url);
    expect(nested.status).toBe(400);
    expect(nested.body.error).toContain("scrapeOptions.bogus");
  });

  test("the SDK's origin / integration fields are rejected too, declared ones pass", async () => {
    const sdk = await scrape({ url: `${pages.url}/plain`, origin: "js-sdk@1" }, strict.url);
    expect(sdk.status).toBe(400);
    const ok = await scrape({ url: `${pages.url}/plain`, formats: ["markdown"], onlyMainContent: false }, strict.url);
    expect(ok.status).toBe(200);
  });
});

describe("load and lifecycle", () => {
  test("50 parallel scrapes all succeed", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => scrape({ url: i % 5 === 0 ? `${pages.url}/gone` : `${pages.url}/article?i=${i}` })),
    );
    for (const [i, r] of results.entries()) {
      expect(r.status, `request ${i}`).toBe(200);
      expect(r.body.data.metadata.statusCode).toBe(i % 5 === 0 ? 404 : 200);
    }
  }, 120_000);

  test("parallel searches with scraping and plain scrapes mix", async () => {
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => search({ query: "x", limit: 2, scrapeOptions: { formats: ["markdown"] } })),
      ...Array.from({ length: 10 }, () => scrape({ url: `${pages.url}/article` })),
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
  }, 120_000);

  test("SEX_CONCURRENCY=1 serialises page fetches but every request still succeeds", async () => {
    const c = await serve(lite, ["--allow-private-network", "--concurrency", "1"], { env: { SEX_SEARXNG_URL: searx.url } });
    try {
      const t = Date.now();
      const rs = await Promise.all(Array.from({ length: 3 }, () => scrape({ url: `${pages.url}/slow?ms=600` }, c.url)));
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(Date.now() - t).toBeGreaterThanOrEqual(1700);
    } finally {
      await c.stop();
    }
  });

  test("SIGTERM exits 0 and logs nothing at error level", async () => {
    const c = await serve(lite, [], { env: { SEX_SEARXNG_URL: searx.url } });
    expect((await api(c.url, "/health")).status).toBe(200);
    expect(await c.stop("SIGTERM")).toBe(0);
    expect(c.stderr()).not.toMatch(/ERROR/);
  });

  test("SIGINT also exits cleanly, and the port is closed afterwards", async () => {
    const c = await serve(lite, [], { env: { SEX_SEARXNG_URL: searx.url } });
    const code = await c.stop("SIGINT");
    expect([0, 130]).toContain(code);
    await expect(fetch(`${c.url}/health`)).rejects.toThrow();
  });

  test("SIGTERM during a slow scrape still exits 0 within a few seconds", async () => {
    const c = await serve(lite, ["--allow-private-network"], { env: { SEX_SEARXNG_URL: searx.url } });
    const pending = scrape({ url: `${pages.url}/slow?ms=30000` }, c.url).catch(() => undefined);
    await until(() => (pages.hits.some((h) => h.startsWith("/slow?ms=30000")) ? true : undefined), 10_000);
    const t = Date.now();
    expect(await c.stop("SIGTERM")).toBe(0);
    expect(Date.now() - t).toBeLessThan(15_000);
    await pending;
  });
});
