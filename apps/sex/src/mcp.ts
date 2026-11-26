import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { SearchRequest } from "@searxng-js/sex-search";
import { z } from "zod";
import type { Engine, ScrapeRequest } from "./engine.ts";
import { failure } from "./errors.ts";
import { VERSION } from "./version.ts";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

export function buildServer(engine: Engine): McpServer {
  const server = new McpServer({ name: "sex", version: VERSION });

  server.registerTool(
    "web_fetch",
    {
      description:
        'Fetch one URL and return its main content as markdown (default). Other formats: "html", "rawHtml", "links". Set onlyMainContent:false for the whole page.',
      annotations: { title: "Fetch web page", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      inputSchema: z.object({ url: z.string().min(1), formats: z.array(z.string()).optional() }).loose(),
    },
    (args, ctx) =>
      run(async () => {
        const { data } = await engine.scrape(args as ScrapeRequest, ctx.mcpReq.signal);
        const markdownOnly = !args.formats || (args.formats.length === 1 && args.formats[0] === "markdown");
        if (!markdownOnly || typeof data.markdown !== "string") return JSON.stringify(data);
        return `Title: ${String(data.title ?? "")}\nURL: ${String(args.url)}\n\n${data.markdown}`;
      }),
  );

  server.registerTool(
    "web_search",
    {
      description:
        'Search the web. Returns ranked results (url, title, description) grouped by source ("web", "news", "images").',
      annotations: { title: "Web search", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      inputSchema: SearchRequest,
    },
    (args, ctx) =>
      run(async () => {
        const { data, warning, provider } = await engine.search(args, ctx.mcpReq.signal);
        return JSON.stringify({ ...data, provider, ...(warning ? { warning } : {}) });
      }),
  );

  return server;
}

/** `sex mcp`: the tools over stdio, for an AI agent that runs the binary itself. */
export async function runStdio(engine: Engine): Promise<void> {
  await buildServer(engine).connect(new StdioServerTransport());
}

async function run(body: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await body() }] };
  } catch (err) {
    const e = failure(err);
    return { content: [{ type: "text", text: `${e.code}: ${e.message}` }], isError: true };
  }
}
