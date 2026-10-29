import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serveHttp } from "../src/http/server.ts";
import { testEngine } from "./helpers.ts";

type ToolText = { content: Array<{ type: string; text: string }> };

const htmlPage = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><article><h1>${title}</h1>${body}</article></main></body></html>`;

/** Root page linking to 1,000 small pages, used for web_map. */
function startLinkSite() {
  const links = Array.from({ length: 1000 }, (_, i) => `<a href="/p/${i + 1}">Page ${i + 1}</a>`).join(" ");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/") return new Response(htmlPage("Index", `<p>${links}</p>`), { headers: { "content-type": "text/html" } });
      if (pathname.startsWith("/p/"))
        return new Response(htmlPage(`Small ${pathname}`, "<p>Small page body.</p>"), { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Root links to 10 pages of roughly 55 KB of text each, used for crawl and fetch. */
function startBigSite() {
  const big = (n: number) =>
    htmlPage(
      `Big ${n}`,
      Array.from(
        { length: 50 },
        (_, p) => `<p>Big ${n} paragraph ${p}. ${"lorem ipsum dolor sit amet consectetur adipiscing elit sed do. ".repeat(18)}</p>`,
      ).join(""),
    );
  const rootLinks = Array.from({ length: 10 }, (_, i) => `<a href="/big/${i + 1}">Big ${i + 1}</a>`).join(" ");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/") return new Response(htmlPage("Root", `<p>${rootLinks}</p>`), { headers: { "content-type": "text/html" } });
      const m = /^\/big\/(\d+)$/.exec(pathname);
      if (m) return new Response(big(Number(m[1])), { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("mcp output limits", () => {
  let links: ReturnType<typeof startLinkSite>;
  let big: ReturnType<typeof startBigSite>;
  let server: Awaited<ReturnType<typeof serveHttp>>;
  let client: Client;

  beforeAll(async () => {
    links = startLinkSite();
    big = startBigSite();
    const engine = testEngine();
    server = await serveHttp(engine, { port: 0, host: "127.0.0.1" });
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    await server.stop();
    links.stop();
    big.stop();
  });

  test("web_map returns at most 200 links by default", async () => {
    const res = (await client.callTool({ name: "web_map", arguments: { url: links.url } })) as ToolText;
    const body = JSON.parse(res.content[0]?.text ?? "{}") as { links: unknown[] };
    expect(body.links.length).toBeGreaterThan(0);
    expect(body.links.length).toBeLessThanOrEqual(200);
  });

  test("web_crawl_status pages stay within the MCP budget", async () => {
    const started = (await client.callTool({
      name: "web_crawl",
      arguments: { url: big.url, limit: 10 },
    })) as ToolText;
    const { id } = JSON.parse(started.content[0]?.text ?? "{}") as { id: string };

    const deadline = Date.now() + 30_000;
    let status = "scraping";
    while (status === "scraping" && Date.now() < deadline) {
      await Bun.sleep(100);
      const poll = (await client.callTool({ name: "web_crawl_status", arguments: { id } })) as ToolText;
      status = (JSON.parse(poll.content[0]?.text ?? "{}") as { status: string }).status;
    }
    expect(status).toBe("completed");

    const first = (await client.callTool({ name: "web_crawl_status", arguments: { id } })) as ToolText;
    const text = first.content[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(210_000);
    const body = JSON.parse(text) as { nextSkip: number | null; data: unknown[] };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.nextSkip).not.toBeNull();
  });

  test("web_fetch returns markdown with a title and URL header", async () => {
    const res = (await client.callTool({ name: "web_fetch", arguments: { url: `${big.url}/big/1` } })) as ToolText;
    expect(res.content[0]?.text ?? "").toStartWith("Title:");
  });
});
