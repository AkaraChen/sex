import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Engine } from "../src/core/engine.ts";
import { createApp } from "../src/http/server.ts";
import { type McpRunning, serveMcp } from "../src/mcp/server.ts";
import { startFixtureSite, startMockSearxng, testEngine } from "./helpers.ts";

let site: ReturnType<typeof startFixtureSite>;
let searx: ReturnType<typeof startMockSearxng>;
let engine: Engine;

beforeAll(() => {
  site = startFixtureSite();
  searx = startMockSearxng(site.url);
  engine = testEngine({ searxngUrl: searx.url });
});

afterAll(async () => {
  await engine.close();
  site.stop();
  searx.stop();
});

describe("http", () => {
  const call = async (method: string, path: string, body?: unknown) => {
    const app = createApp(engine);
    const res = await app.fetch(
      new Request(`http://sex.test${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  test("POST /v2/scrape", async () => {
    const { status, body } = await call("POST", "/v2/scrape", { url: `${site.url}/docs/a`, formats: ["markdown"], origin: "js-sdk" });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.markdown).toStartWith("# Doc A");
  });

  test("validation and capability errors use Firecrawl's error shape", async () => {
    const invalid = await call("POST", "/v2/scrape", { formats: ["markdown"] });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ success: false, code: "BAD_REQUEST" });
    expect(invalid.body.error).toContain("url");

    const noBrowser = await call("POST", "/v2/scrape", { url: site.url, actions: [{ type: "scrape" }] });
    expect(noBrowser.status).toBe(501);
    expect(noBrowser.body).toMatchObject({ success: false, code: "BROWSER_NOT_CONFIGURED" });

    const missing = await call("GET", "/v2/crawl/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.body.success).toBe(false);
  });

  test("POST /v2/search and /v2/map", async () => {
    const search = await call("POST", "/v2/search", { query: "docs", limit: 1 });
    expect(search.body).toEqual({
      success: true,
      data: { web: [{ url: `${site.url}/docs/a`, title: "Doc A", description: "About doc a", position: 1 }] },
    });
    const map = await call("POST", "/v2/map", { url: site.url, limit: 3 });
    expect(map.body.links).toHaveLength(3);
  });

  test("crawl lifecycle with status URL, pagination fields and errors", async () => {
    const started = await call("POST", "/v2/crawl", { url: `${site.url}/`, limit: 3, sitemap: "skip" });
    expect(started.body.url).toBe(`http://sex.test/v2/crawl/${started.body.id}`);
    const id = started.body.id as string;
    let status: Record<string, any> = {};
    for (let i = 0; i < 200 && status.status !== "completed"; i++) {
      status = (await call("GET", `/v2/crawl/${id}`)).body;
      await Bun.sleep(20);
    }
    expect(status).toMatchObject({ success: true, status: "completed", completed: 3, next: null });
    expect(status.data).toHaveLength(3);
    const skipped = await call("GET", `/v2/crawl/${id}?skip=2`);
    expect(skipped.body.data).toHaveLength(1);
    const errors = await call("GET", `/v2/crawl/${id}/errors`);
    expect(errors.body.robotsBlocked).toEqual([`${site.url}/private/x`]);
    const cancel = await call("DELETE", `/v2/crawl/${id}`);
    expect(cancel.status).toBe(409);
  });

  test("OpenAPI spec and docs", async () => {
    const app = createApp(engine);
    const spec = (await (await app.fetch(new Request("http://sex.test/openapi.json"))).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toContain("/v2/scrape");
    expect(Object.keys(spec.paths)).toContain("/v2/crawl/{id}");
    const docs = await app.fetch(new Request("http://sex.test/docs"));
    expect(await docs.text()).toContain("scalar");
  });
});

describe("mcp (streamable http)", () => {
  let server: McpRunning;
  let client: Client;

  beforeAll(async () => {
    const port = 41000 + Math.floor(Math.random() * 1000);
    server = await serveMcp(engine, { transport: "http", port, host: "127.0.0.1", stateless: false });
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    await server.stop();
  });

  test("lists tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["web_crawl", "web_crawl_status", "web_extract", "web_fetch", "web_map", "web_search"]);
  });

  test("web_fetch and web_search", async () => {
    const fetched = (await client.callTool({ name: "web_fetch", arguments: { url: `${site.url}/docs/a` } })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(fetched.content[0]?.text ?? "{}").markdown).toStartWith("# Doc A");

    const searched = (await client.callTool({ name: "web_search", arguments: { query: "docs", limit: 1 } })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(searched.content[0]?.text ?? "{}").web[0].url).toBe(`${site.url}/docs/a`);
  });

  test("tool errors are reported, not thrown", async () => {
    const res = (await client.callTool({ name: "web_fetch", arguments: { url: site.url, formats: ["summary"] } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("LLM_NOT_CONFIGURED");
  });
});

describe("mcp (stdio)", () => {
  test("lists tools over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp"],
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH ?? "", SEX_SEARXNG_URL: searx.url },
      stderr: "ignore",
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "web_crawl",
        "web_crawl_status",
        "web_extract",
        "web_fetch",
        "web_map",
        "web_search",
      ]);
    } finally {
      await client.close();
    }
  });
});
