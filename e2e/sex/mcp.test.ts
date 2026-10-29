// MCP at /mcp (streamable HTTP, stateless) with the official client: tool lists and a call of every tool.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockLlm } from "../lib/llm.ts";
import { killAll, type Server, until } from "../lib/proc.ts";
import { startMockSearxng } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { llmFlags, startSex } from "./helpers.ts";
import { type TreeSite, treeSite } from "./tree-site.ts";

let srv: Server;
let firecrawlNames: Server;
let tree: TreeSite;
let slow: TreeSite;
let searxng: ReturnType<typeof startMockSearxng>;
let llm: ReturnType<typeof startMockLlm>;
const clients: Client[] = [];

async function connect(server: Server): Promise<Client> {
  const client = new Client({ name: "sex-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  clients.push(client);
  return client;
}

/** Calls a tool and returns its JSON text content (or the text when it is not JSON). */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value: any; text: string }> {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  const text = res.content.map((c) => c.text ?? "").join("\n");
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {}
  return { isError: !!res.isError, value, text };
}

beforeAll(async () => {
  tree = treeSite();
  slow = treeSite({ delayMs: 400 });
  searxng = startMockSearxng(tree.url);
  llm = startMockLlm((req) => {
    const system = req.messages[0]?.content ?? "";
    if (system.includes("write the JSON Schema")) return JSON.stringify({ type: "object", properties: { heading: { type: "string" } } });
    return JSON.stringify({ heading: "Page /" });
  });
  srv = await startSex([...llmFlags(llm), "--searxng-url", searxng.url]);
  firecrawlNames = await startSex(["--searxng-url", searxng.url], { env: { SEX_MCP_TOOL_NAMES: "firecrawl" } });
});

afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  tree.stop();
  slow.stop();
  searxng.stop();
  llm.stop();
  await killAll();
  removeTempDirs();
});

describe("tool list", () => {
  test("the web_* tools, each with a description and an input schema", async () => {
    const client = await connect(srv);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "web_fetch",
        "web_search",
        "web_map",
        "web_crawl",
        "web_crawl_status",
        "web_crawl_cancel",
        "web_batch_scrape",
        "web_batch_status",
        "web_extract",
        "web_extract_status",
      ].sort(),
    );
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe("object");
    }
    const fetchTool = tools.find((t) => t.name === "web_fetch");
    expect(JSON.stringify(fetchTool?.inputSchema)).toContain('"url"');
    expect(tools.find((t) => t.name === "web_crawl_cancel")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "web_fetch")?.annotations?.readOnlyHint).toBe(true);
  });

  test("SEX_MCP_TOOL_NAMES=firecrawl renames the six tools firecrawl-mcp has", async () => {
    const client = await connect(firecrawlNames);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of [
      "firecrawl_scrape",
      "firecrawl_search",
      "firecrawl_map",
      "firecrawl_crawl",
      "firecrawl_check_crawl_status",
      "firecrawl_extract",
    ])
      expect(names).toContain(n);
    for (const n of ["web_fetch", "web_search", "web_map", "web_crawl", "web_crawl_status", "web_extract"]) expect(names).not.toContain(n);
    // The tools firecrawl-mcp lacks keep their names.
    for (const n of ["web_crawl_cancel", "web_batch_scrape", "web_batch_status", "web_extract_status"]) expect(names).toContain(n);
    const r = await call(client, "firecrawl_scrape", { url: `${tree.url}/d1` });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Page /d1");
  });

  test("the endpoint is stateless: a second client sees the same tools", async () => {
    const [a, b] = [await connect(srv), await connect(srv)];
    expect((await a.listTools()).tools.length).toBe((await b.listTools()).tools.length);
  });

  test("without an LLM the tool list is the same and extract is a tool error", async () => {
    const bare = await startSex();
    const client = await connect(bare);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("web_extract");
    const r = await call(client, "web_extract", { urls: [`${tree.url}/`], prompt: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("LLM");
    await bare.stop();
  });
});

describe("calling the tools", () => {
  test("web_fetch returns the page as markdown; options apply; errors are tool errors", async () => {
    const client = await connect(srv);
    const md = await call(client, "web_fetch", { url: `${tree.url}/d1` });
    expect(md.isError).toBe(false);
    expect(md.text).toContain("Page /d1");
    const links = await call(client, "web_fetch", { url: `${tree.url}/`, formats: ["links"] });
    expect(links.isError).toBe(false);
    expect(links.text).toContain(`${tree.url}/blog/1`);
    const missing = await call(client, "web_fetch", { url: "http://127.0.0.1:1/" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("SCRAPE_SITE_ERROR");
    const invalid = await client.callTool({ name: "web_fetch", arguments: { url: 42 } }).catch((e) => e);
    // Bad arguments are either a protocol error or an error result; never a success.
    expect(invalid instanceof Error || (invalid as any).isError === true).toBe(true);
  });

  test("web_search returns the results", async () => {
    const client = await connect(srv);
    const r = await call(client, "web_search", { query: "doc a", limit: 3 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`${tree.url}/docs/a`);
  });

  test("web_map lists URLs", async () => {
    const client = await connect(srv);
    const r = await call(client, "web_map", { url: `${tree.url}/`, limit: 5 });
    expect(r.isError).toBe(false);
    expect(r.value.links.length).toBe(5);
    expect(r.value.links[0].url).toBe(`${tree.url}/`);
  });

  test("web_crawl, web_crawl_status and web_crawl_cancel", async () => {
    const client = await connect(srv);
    const started = await call(client, "web_crawl", { url: `${tree.url}/`, limit: 4, sitemap: "skip" });
    expect(started.isError).toBe(false);
    expect(started.value.id).toBeTruthy();
    expect(started.value.message).toContain("web_crawl_status");
    const done = await until(
      async () => {
        const s = await call(client, "web_crawl_status", { id: started.value.id });
        expect(s.isError).toBe(false);
        return s.value.status === "completed" ? s.value : undefined;
      },
      60_000,
      200,
    );
    expect(done.data).toHaveLength(4);
    expect(done.data[0].markdown).toContain("Page ");

    const running = await call(client, "web_crawl", { url: `${slow.url}/`, limit: 30, maxConcurrency: 1, sitemap: "skip" });
    await Bun.sleep(600);
    const cancelled = await call(client, "web_crawl_cancel", { id: running.value.id });
    expect(cancelled.isError).toBe(false);
    expect(cancelled.value).toEqual({ id: running.value.id, status: "cancelled" });
    const after = await call(client, "web_crawl_status", { id: running.value.id });
    expect(after.value.status).toBe("cancelled");

    const unknown = await call(client, "web_crawl_status", { id: "00000000-0000-4000-8000-000000000000" });
    expect(unknown.isError).toBe(true);
  }, 60_000);

  test("web_crawl_status pages with skip when a result is large", async () => {
    const client = await connect(srv);
    const started = await call(client, "web_crawl", { url: `${tree.url}/wide/`, limit: 3, sitemap: "skip" });
    const s = await until(
      async () => {
        const r = await call(client, "web_crawl_status", { id: started.value.id });
        return r.value.status === "completed" ? r.value : undefined;
      },
      60_000,
      200,
    );
    expect(s.data.length).toBe(3);
    const skipped = await call(client, "web_crawl_status", { id: started.value.id, skip: 2 });
    expect(skipped.value.data).toHaveLength(1);
  });

  test("web_batch_scrape and web_batch_status", async () => {
    const client = await connect(srv);
    const started = await call(client, "web_batch_scrape", { urls: [`${tree.url}/d1`, `${tree.url}/d2`, "nope"], formats: ["markdown"] });
    expect(started.isError).toBe(false);
    expect(started.value.invalidURLs).toEqual(["nope"]);
    const done = await until(
      async () => {
        const r = await call(client, "web_batch_status", { id: started.value.id });
        expect(r.isError).toBe(false);
        return r.value.status === "completed" ? r.value : undefined;
      },
      60_000,
      200,
    );
    expect(done.data.map((d: any) => d.metadata.sourceURL).sort()).toEqual([`${tree.url}/d1`, `${tree.url}/d2`]);
  });

  test("web_extract waits for the result", async () => {
    const client = await connect(srv);
    const r = await call(client, "web_extract", {
      urls: [`${tree.url}/`],
      prompt: "the heading",
      schema: { type: "object", properties: { heading: { type: "string" } } },
    });
    expect(r.isError).toBe(false);
    expect(r.value.data).toEqual({ heading: "Page /" });
  });

  test("web_extract with async: true returns an id for web_extract_status", async () => {
    const client = await connect(srv);
    const started = await call(client, "web_extract", { urls: [`${tree.url}/`], prompt: "the heading", async: true });
    expect(started.isError).toBe(false);
    expect(started.value.status).toBe("processing");
    expect(started.value.message).toContain("web_extract_status");
    const done = await until(
      async () => {
        const r = await call(client, "web_extract_status", { id: started.value.id });
        expect(r.isError).toBe(false);
        return r.value.status === "processing" ? undefined : r.value;
      },
      60_000,
      200,
    );
    expect(done.status).toBe("completed");
    expect(done.data).toEqual({ heading: "Page /" });
    const unknown = await call(client, "web_extract_status", { id: "00000000-0000-4000-8000-000000000000" });
    expect(unknown.isError).toBe(true);
  });
});

describe("transport", () => {
  test("GET /health is JSON on the same port and /mcp refuses a foreign Origin", async () => {
    const health = await fetch(`${srv.url}/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe("ok");
    const res = await fetch(`${srv.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "http://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
  });
});
