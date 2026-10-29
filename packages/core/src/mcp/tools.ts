import type { McpServer } from "@modelcontextprotocol/server";
import { toAppError } from "@searxng-js/sex-errors";
import type { BaseEngine } from "../engine.ts";
import { log } from "../log.ts";
import { type Document, ScrapeRequest, SearchRequest } from "../schemas.ts";

export const json = (value: unknown) => JSON.stringify(value);

/** Returns a page as markdown with a short header when the caller asked for markdown only. */
function fetchResult(args: ScrapeRequest, doc: Document): string {
  const markdownOnly = !args.formats || (args.formats.length === 1 && args.formats[0] === "markdown");
  if (!markdownOnly || typeof doc.markdown !== "string") return json(doc);
  return `Title: ${doc.metadata?.title ?? ""}\nURL: ${doc.metadata?.url ?? ""}\n\n${doc.markdown}`;
}

/** A failure whose message is shown to the client as-is (no error code prefix). */
export class ToolMessageError extends Error {}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

/** Runs a tool body, reporting failures as MCP tool errors with the server's message. */
export async function guard(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    if (err instanceof ToolMessageError) return { content: [{ type: "text", text: err.message }], isError: true };
    const e = toAppError(err);
    log.warn("mcp tool failed", { code: e.code, error: e.message });
    return { content: [{ type: "text", text: `${e.code}: ${e.message}` }], isError: true };
  }
}

/** Registers `web_fetch` and `web_search` (or the names in `opts.names`). `llmFormats` mentions the LLM formats in web_fetch's description. */
export function registerFetchAndSearch(
  server: McpServer,
  engine: BaseEngine,
  opts: { llmFormats: boolean; names?: { fetch: string; search: string } },
): void {
  const formats = opts.llmFormats
    ? '"html", "rawHtml", "links", "images", "summary" / {type:"json",prompt,schema} (LLM)'
    : '"html", "rawHtml", "links", "images"';
  server.registerTool(
    opts.names?.fetch ?? "web_fetch",
    {
      description: `Fetch one URL and return its main content as markdown (default). Other formats: ${formats}. Set onlyMainContent:false for the whole page.`,
      annotations: { title: "Fetch web page", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      inputSchema: ScrapeRequest,
    },
    (args, ctx) => guard(async () => fetchResult(args, await engine.scrape(args, ctx.mcpReq.signal))),
  );

  server.registerTool(
    opts.names?.search ?? "web_search",
    {
      description:
        'Search the web. Returns ranked results (url, title, description) grouped by source ("web", "news", "images"). Add scrapeOptions:{formats:["markdown"]} to also fetch each result\'s content; usually prefer web_fetch on the few URLs you need.',
      annotations: { title: "Web search", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      inputSchema: SearchRequest,
    },
    (args, ctx) =>
      guard(async () => {
        const { data, warning } = await engine.search(args, ctx.mcpReq.signal);
        return json(warning ? { ...data, warning } : data);
      }),
  );
}
