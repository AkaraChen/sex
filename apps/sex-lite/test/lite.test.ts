import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveCoreConfig } from "@sex/core/config.ts";
import type { BaseEngine } from "@sex/core/engine.ts";
import { startFixtureSite, startMockSearxng, testCoreConfig } from "@sex/core/test/helpers.ts";
import { liteEngine } from "../src/engine.ts";
import { createApp, serveHttp } from "../src/server.ts";

let site: ReturnType<typeof startFixtureSite>;
let searx: ReturnType<typeof startMockSearxng>;
let engine: BaseEngine;

beforeAll(() => {
  site = startFixtureSite();
  searx = startMockSearxng(site.url);
  engine = liteEngine(testCoreConfig({ searxngUrl: searx.url }));
});

afterAll(async () => {
  await engine.close();
  site.stop();
  searx.stop();
});

describe("http", () => {
  const call = async (method: string, path: string, body?: unknown) => {
    const { app } = createApp(engine);
    const res = await app.fetch(
      new Request(`http://lite.test${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  test("POST /v2/scrape and /v2/search answer like Firecrawl", async () => {
    const scraped = await call("POST", "/v2/scrape", { url: `${site.url}/docs/a`, formats: ["markdown", "links"] });
    expect(scraped.status).toBe(200);
    expect(scraped.body.data.markdown).toStartWith("# Doc A");
    expect(scraped.body.data.links.length).toBeGreaterThan(0);

    const searched = await call("POST", "/v2/search", { query: "docs", limit: 1, scrapeOptions: { formats: ["markdown"] } });
    expect(searched.status).toBe(200);
    expect(searched.body.data.web).toHaveLength(1);
    expect(searched.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(searched.body.creditsUsed).toBe(0);
    expect(searched.body.data.web[0].markdown).toContain("Doc A");
  });

  test("only search and scrape are served", async () => {
    expect((await call("POST", "/v2/crawl", { url: site.url })).status).toBe(404);
    expect((await call("POST", "/v2/map", { url: site.url })).status).toBe(404);
    expect((await call("POST", "/v2/parse", { url: site.url })).status).toBe(404);
    const spec = await call("GET", "/openapi.json");
    expect(Object.keys(spec.body.paths).sort()).toEqual(["/v2/scrape", "/v2/search"]);
  });

  test("browser and LLM options are 501s that point at sex", async () => {
    const actions = await call("POST", "/v2/scrape", { url: site.url, actions: [{ type: "scrape" }] });
    expect(actions.status).toBe(501);
    expect(actions.body.code).toBe("BROWSER_NOT_CONFIGURED");
    expect(actions.body.error).toContain("sex-lite has no browser");

    const summary = await call("POST", "/v2/scrape", { url: site.url, formats: ["summary"] });
    expect(summary.status).toBe(501);
    expect(summary.body.code).toBe("LLM_NOT_CONFIGURED");
    expect(summary.body.error).toContain("sex-lite has no LLM");
  });

  test("changeTracking is a 501 that points at sex", async () => {
    const res = await call("POST", "/v2/scrape", {
      url: `${site.url}/docs/b`,
      formats: ["markdown", { type: "changeTracking", modes: ["git-diff"] }],
    });
    expect(res.status).toBe(501);
    expect(res.body.code).toBe("NOT_SUPPORTED");
    expect(res.body.error).toContain("sex supports it");
  });

  test("options that cannot be honoured are refused or reported, not dropped", async () => {
    const redact = await call("POST", "/v2/scrape", { url: `${site.url}/docs/b`, redactPII: true });
    expect(redact.status).toBe(501);
    const cached = await call("POST", "/v2/scrape", { url: `${site.url}/docs/b`, lockdown: true });
    expect(cached.status).toBe(404);
    expect(cached.body.code).toBe("SCRAPE_NO_CACHED_DATA");
    const proxy = await call("POST", "/v2/scrape", { url: `${site.url}/docs/b`, proxy: "enhanced" });
    expect(proxy.body.data.warning).toContain("your scrape may be partial");
    const typo = await call("POST", "/v2/scrape", { url: site.url, parsers: ["pfd"] });
    expect(typo.status).toBe(400);
    const raw = await call("POST", "/v2/scrape", { url: `${site.url}/data.json`, formats: ["rawBase64"] });
    expect(Buffer.from(raw.body.data.rawBase64, "base64").toString()).toContain("hello");
  });

  test("unknown fields are dropped, or 400 with SEX_STRICT_REQUESTS", async () => {
    const lenient = await call("POST", "/v2/scrape", { url: `${site.url}/docs/b`, origin: "sdk" });
    expect(lenient.status).toBe(200);
    const strictEngine = liteEngine(
      resolveCoreConfig({ allowPrivateNetwork: true }, { allowPrivateNetwork: true }, { SEX_STRICT_REQUESTS: "1" }),
    );
    const { app } = createApp(strictEngine);
    const post = (path: string, body: unknown) =>
      app.fetch(
        new Request(`http://lite.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const top = await post("/v2/scrape", { url: `${site.url}/docs/b`, origin: "sdk" });
    expect(top.status).toBe(400);
    expect(JSON.stringify(await top.json())).toContain('Unrecognized key in body: \\"origin\\"');
    const nested = await post("/v2/search", { query: "docs", scrapeOptions: { formats: ["markdown"], bogus: 1 } });
    expect(nested.status).toBe(400);
    expect(JSON.stringify(await nested.json())).toContain("scrapeOptions.bogus");
    expect((await post("/v2/scrape", { url: `${site.url}/docs/b`, formats: ["markdown"] })).status).toBe(200);
    await strictEngine.close();
  });

  test("/health reports SearXNG only", async () => {
    const health = await call("GET", "/health");
    expect(Object.keys(health.body).sort()).toEqual(["searxng", "status", "version"]);
  });
});

describe("mcp (streamable http at /mcp)", () => {
  let server: ReturnType<typeof serveHttp>;
  let client: Client;

  beforeAll(async () => {
    server = serveHttp(engine, { port: 0, host: "127.0.0.1" });
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.server.port}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    await server.stop();
  });

  test("web_fetch and web_search are the only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["web_fetch", "web_search"]);
    expect(tools.find((t) => t.name === "web_fetch")?.description).not.toContain("LLM");

    const fetched = (await client.callTool({ name: "web_fetch", arguments: { url: `${site.url}/docs/a` } })) as {
      content: Array<{ text: string }>;
    };
    expect(fetched.content[0]?.text).toContain("# Doc A");
    const searched = (await client.callTool({ name: "web_search", arguments: { query: "docs", limit: 1 } })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(searched.content[0]?.text ?? "{}").web).toHaveLength(1);
  });
});

describe("cli", () => {
  // Minimal env so no SEX_* variables from the developer's shell leak into the run.
  const cli = async (args: string[]) => {
    const proc = Bun.spawn(["bun", "--conditions", "sex-source", "src/cli.ts", ...args], {
      cwd: resolve(import.meta.dir, ".."),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr };
  };

  test("fetch prints markdown", async () => {
    const { code, stdout } = await cli(["fetch", `${site.url}/docs/a`]);
    expect(code).toBe(0);
    expect(stdout).toStartWith("# Doc A");
  }, 20_000);

  test("search prints ranked results", async () => {
    const { code, stdout } = await cli(["search", "docs", "--searxng-url", searx.url, "-n", "2"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`1. Doc A\n   ${site.url}/docs/a`);
  }, 20_000);

  test("an LLM format fails with LLM_NOT_CONFIGURED and exit code 1", async () => {
    const { code, stderr } = await cli(["fetch", `${site.url}/docs/a`, "-f", "summary"]);
    expect(code).toBe(1);
    expect(stderr).toContain("LLM_NOT_CONFIGURED");
  }, 20_000);
});
