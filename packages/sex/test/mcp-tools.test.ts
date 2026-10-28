import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serveHttp } from "../src/http/server.ts";
import { startFixtureSite, startMockLlm, testEngine, waitFor } from "./helpers.ts";

type ToolText = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function connect(engine: ReturnType<typeof testEngine>) {
  const server = serveHttp(engine, { port: 0, host: "127.0.0.1" });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.server.port}/mcp`)));
  return { server, client };
}

describe("mcp job tools", () => {
  let site: ReturnType<typeof startFixtureSite>;
  let llm: ReturnType<typeof startMockLlm>;
  let engine: ReturnType<typeof testEngine>;
  let ctx: Awaited<ReturnType<typeof connect>>;

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await ctx.client.callTool({ name, arguments: args })) as ToolText;
    return { isError: res.isError === true, text: res.content[0]?.text ?? "" };
  };
  const callJson = async (name: string, args: Record<string, unknown>) => JSON.parse((await call(name, args)).text);

  beforeAll(async () => {
    site = startFixtureSite();
    llm = startMockLlm(() => JSON.stringify({ title: "Doc A" }));
    engine = testEngine({ llmModel: "m", llmBaseUrl: llm.url });
    ctx = await connect(engine);
  });

  afterAll(async () => {
    await ctx.client.close();
    await ctx.server.stop();
    await engine.close();
    site.stop();
    llm.stop();
  });

  test("lists the job tools under their web_ names", async () => {
    const names = (await ctx.client.listTools()).tools.map((t) => t.name);
    for (const n of ["web_batch_scrape", "web_batch_status", "web_crawl_cancel", "web_extract_status"]) expect(names).toContain(n);
  });

  test("web_batch_scrape + web_batch_status", async () => {
    const started = await callJson("web_batch_scrape", { urls: [`${site.url}/docs/a`, `${site.url}/docs/b`] });
    expect(typeof started.id).toBe("string");
    let status: { status: string; completed: number; data: Array<{ metadata?: { url?: string } }> } | undefined;
    await waitFor(async () => {
      status = await callJson("web_batch_status", { id: started.id });
      return status?.status === "completed" ? true : undefined;
    });
    expect(status?.completed).toBe(2);
    expect(status?.data).toHaveLength(2);
  });

  test("web_batch_status refuses a crawl id", async () => {
    const crawl = await callJson("web_crawl", { url: site.url, limit: 1 });
    const res = await call("web_batch_status", { id: crawl.id });
    expect(res.isError).toBe(true);
  });

  test("web_crawl_cancel cancels a crawl and a second cancel fails", async () => {
    const crawl = await callJson("web_crawl", { url: site.url, limit: 5 });
    const cancelled = await call("web_crawl_cancel", { id: crawl.id });
    // The tiny crawl may finish first; either way the job ends up finished.
    if (!cancelled.isError) expect(JSON.parse(cancelled.text).status).toBe("cancelled");
    const again = await call("web_crawl_cancel", { id: crawl.id });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("JOB_FINISHED");
  });

  test("web_extract with async returns an id; web_extract_status gives the result", async () => {
    const started = await callJson("web_extract", {
      urls: [`${site.url}/docs/a`],
      prompt: "Get the title",
      schema: { type: "object" },
      async: true,
    });
    expect(typeof started.id).toBe("string");
    expect(started.data).toBeUndefined();
    let status: { status: string; data?: unknown } | undefined;
    await waitFor(async () => {
      status = await callJson("web_extract_status", { id: started.id });
      return status?.status !== "processing" ? true : undefined;
    });
    expect(status).toEqual({ status: "completed", data: { title: "Doc A" } });
  });

  test("SEX_MCP_TOOL_NAMES=firecrawl renames the tools firecrawl-mcp has", async () => {
    const fc = testEngine({ mcpToolNames: "firecrawl" });
    const c = await connect(fc);
    try {
      const names = (await c.client.listTools()).tools.map((t) => t.name);
      for (const n of [
        "firecrawl_scrape",
        "firecrawl_search",
        "firecrawl_map",
        "firecrawl_crawl",
        "firecrawl_check_crawl_status",
        "firecrawl_extract",
      ])
        expect(names).toContain(n);
      expect(names).not.toContain("web_fetch");
      expect(names).toContain("web_batch_scrape");
    } finally {
      await c.client.close();
      await c.server.stop();
      await fc.close();
    }
  });
});
