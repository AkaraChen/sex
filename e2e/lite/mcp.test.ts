import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bin } from "../lib/bin.ts";
import { api, killAll, type Server, serve } from "../lib/proc.ts";
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
const clients: Client[] = [];

beforeAll(async () => {
  s = await serve(lite, ["--allow-private-network"], { env: { SEX_SEARXNG_URL: searx.url } });
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await s.stop();
  pages.stop();
  searx.stop();
  await killAll();
  removeTempDirs();
});

async function connect(base = s.url): Promise<Client> {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(client);
  return client;
}

const text = (r: any): string => r.content.map((c: any) => c.text).join("\n");

describe("MCP over HTTP at /mcp", () => {
  test("initialize reports the server, and tools/list is exactly web_fetch and web_search", async () => {
    const c = await connect();
    expect(c.getServerVersion()?.name).toBeTruthy();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["web_fetch", "web_search"]);
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
    }
    const fetchTool = tools.find((t) => t.name === "web_fetch")!;
    expect(fetchTool.inputSchema.required).toEqual(["url"]);
    expect(Object.keys(fetchTool.inputSchema.properties!)).toEqual(
      expect.arrayContaining(["url", "formats", "onlyMainContent", "timeout"]),
    );
    const searchTool = tools.find((t) => t.name === "web_search")!;
    expect(searchTool.inputSchema.required).toEqual(["query"]);
  });

  test("web_fetch returns the page as text with title and URL", async () => {
    const c = await connect();
    const r = await c.callTool({ name: "web_fetch", arguments: { url: `${pages.url}/article` } });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toContain("Title: Test Article");
    expect(t).toContain(`URL: ${pages.url}/article`);
    expect(t).toContain("# Heading One");
    expect(t).not.toContain("FOOTER-TEXT");
  });

  test("web_fetch with formats and options", async () => {
    const c = await connect();
    const r = await c.callTool({
      name: "web_fetch",
      arguments: { url: `${pages.url}/article`, formats: ["links"], onlyMainContent: false },
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain(`${pages.url}/foot-link`);
  });

  test("web_search returns the results as JSON text; the CLI-style default limit applies", async () => {
    const c = await connect();
    const r = await c.callTool({ name: "web_search", arguments: { query: "anything" } });
    expect(r.isError).toBeFalsy();
    const data = JSON.parse(text(r));
    expect(data.web.map((w: any) => w.url)).toEqual([`${pages.url}/article`, `${pages.url}/gone`, "https://github.com/o/r"]);
    const one = JSON.parse(text(await c.callTool({ name: "web_search", arguments: { query: "anything", limit: 1 } })));
    expect(one.web).toHaveLength(1);
  });

  test("web_search with scrapeOptions scrapes the results", async () => {
    const c = await connect();
    const r = await c.callTool({
      name: "web_search",
      arguments: { query: "x", limit: 1, scrapeOptions: { formats: ["markdown"] } },
    });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).web[0].markdown).toContain("Heading One");
  });

  describe("bad calls are tool errors, never a crash", () => {
    test("missing and mistyped arguments", async () => {
      const c = await connect();
      for (const [name, args] of [
        ["web_fetch", {}],
        ["web_fetch", { url: 5 }],
        ["web_fetch", { url: `${pages.url}/article`, formats: "markdown" }],
        ["web_fetch", { url: `${pages.url}/article`, timeout: 1 }],
        ["web_search", {}],
        ["web_search", { query: "x", limit: 0 }],
        ["web_search", { query: "x", sources: ["bogus"] }],
      ] as const) {
        const r = await c.callTool({ name, arguments: args as any });
        expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
        expect(text(r).length).toBeGreaterThan(0);
      }
      // The server is still alive afterwards.
      expect((await api(s.url, "/health")).status).toBe(200);
      expect((await c.callTool({ name: "web_fetch", arguments: { url: `${pages.url}/plain` } })).isError).toBeFalsy();
    });

    test("scrape failures keep their error code in the message", async () => {
      const c = await connect();
      const bad = await c.callTool({ name: "web_fetch", arguments: { url: "not a url" } });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toContain("BAD_REQUEST");
      const refused = await c.callTool({ name: "web_fetch", arguments: { url: "http://127.0.0.1:1/" } });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("SCRAPE_SITE_ERROR");
      const llm = await c.callTool({ name: "web_fetch", arguments: { url: `${pages.url}/article`, formats: ["json"] } });
      expect(llm.isError).toBe(true);
      expect(text(llm)).toContain("LLM_NOT_CONFIGURED");
      expect(text(llm)).toContain("sex");
      const actions = await c.callTool({
        name: "web_fetch",
        arguments: { url: `${pages.url}/article`, actions: [{ type: "wait", milliseconds: 10 }] },
      });
      expect(actions.isError).toBe(true);
      expect(text(actions)).toContain("BROWSER_NOT_CONFIGURED");
    });

    test("a SearXNG failure is a tool error", async () => {
      const down = await serve(lite, [], { env: { SEX_SEARXNG_URL: "http://127.0.0.1:9" } });
      try {
        const c = await connect(down.url);
        const r = await c.callTool({ name: "web_search", arguments: { query: "x" } });
        expect(r.isError).toBe(true);
        expect(text(r)).toContain("SEARCH_BACKEND_UNAVAILABLE");
      } finally {
        await down.stop();
      }
    });

    test("tools sex has but sex-lite does not are protocol errors (not found)", async () => {
      const c = await connect();
      for (const name of ["web_map", "web_crawl", "web_extract", "web_batch_scrape", "firecrawl_scrape"]) {
        await expect(c.callTool({ name, arguments: { url: "http://x.test" } }), name).rejects.toThrow();
      }
    });
  });

  test("the transport is stateless: parallel clients and calls work independently", async () => {
    const cs = await Promise.all(Array.from({ length: 4 }, () => connect()));
    const rs = await Promise.all(
      cs.flatMap((c) => [c.callTool({ name: "web_fetch", arguments: { url: `${pages.url}/article` } }), c.listTools()]),
    );
    expect(rs).toHaveLength(8);
  });

  test("raw JSON-RPC: initialize and tools/list work without a session header", async () => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const init = await fetch(`${s.url}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
      }),
    });
    expect(init.status).toBe(200);
    const list = await fetch(`${s.url}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain("web_fetch");
  });

  test("garbage on /mcp is an error response, not a crash; GET is 405", async () => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const bad = await fetch(`${s.url}/mcp`, { method: "POST", headers, body: "{not json" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    const notRpc = await fetch(`${s.url}/mcp`, { method: "POST", headers, body: JSON.stringify({ hello: "world" }) });
    expect(notRpc.status).toBeGreaterThanOrEqual(400);
    expect(notRpc.status).toBeLessThan(500);
    expect((await fetch(`${s.url}/mcp`)).status).toBe(405);
    expect((await api(s.url, "/health")).status).toBe(200);
  });

  test("the Host check covers /mcp too", async () => {
    const r = await fetch(`${s.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(403);
  });

  test("without --allow-private-network a private URL is a tool error and nothing is fetched", async () => {
    const strictServer = await serve(lite, [], { env: { SEX_SEARXNG_URL: searx.url } });
    try {
      pages.hits.length = 0;
      const c = await connect(strictServer.url);
      const r = await c.callTool({ name: "web_fetch", arguments: { url: `${pages.url}/article` } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("PRIVATE_NETWORK_BLOCKED");
      expect(pages.hits).toEqual([]);
    } finally {
      await strictServer.stop();
    }
  });

  test("SEX_MCP_TOOL_NAMES is not one of the variables sex-lite reads: the tool names stay web_*", async () => {
    const f = await serve(lite, ["--allow-private-network"], { env: { SEX_MCP_TOOL_NAMES: "firecrawl", SEX_SEARXNG_URL: searx.url } });
    try {
      const c = await connect(f.url);
      const names = (await c.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(["web_fetch", "web_search"]);
    } finally {
      await f.stop();
    }
  });
});
