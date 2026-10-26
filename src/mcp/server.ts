import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { Engine } from "../core/engine.ts";
import type { JobRecord } from "../core/jobs/index.ts";
import { toAppError } from "../errors.ts";
import { log } from "../log.ts";
import { CrawlRequest, type Document, ExtractRequest, MapRequest, ScrapeRequest, SearchRequest } from "../schemas.ts";
import { VERSION } from "../version.ts";

const EXTRACT_WAIT_MS = 5 * 60 * 1000;
// MCP results land in an LLM context, so they are sized well below the HTTP API's budgets.
const MCP_PAGE_BUDGET_CHARS = 200_000;
const MCP_MAP_DEFAULT_LIMIT = 200;

const McpCrawlRequest = CrawlRequest.extend({
  limit: CrawlRequest.shape.limit.describe("Max pages. Defaults to 20 for this tool."),
});

const McpMapRequest = MapRequest.extend({
  limit: MapRequest.shape.limit.describe(`Max links. Defaults to ${MCP_MAP_DEFAULT_LIMIT} for this tool.`),
});

const TEXT_FIELDS = ["markdown", "html", "rawHtml"] as const;

const json = (value: unknown) => JSON.stringify(value);

/** Returns a page as markdown with a short header when the caller asked for markdown only. */
function fetchResult(args: ScrapeRequest, doc: Document): string {
  const markdownOnly = !args.formats || (args.formats.length === 1 && args.formats[0] === "markdown");
  if (!markdownOnly || typeof doc.markdown !== "string") return json(doc);
  return `Title: ${doc.metadata?.title ?? ""}\nURL: ${doc.metadata?.url ?? ""}\n\n${doc.markdown}`;
}

/** Shortens a single oversized document's text fields until its serialized form fits `maxChars`. */
function fitDocument(doc: Document, maxChars: number): { doc: Document; truncated: boolean } {
  const out: Record<string, unknown> = { ...doc };
  let truncated = false;
  for (let size = json(out).length; size > maxChars; size = json(out).length) {
    const fields = TEXT_FIELDS.filter((k) => typeof out[k] === "string" && (out[k] as string).length > 0);
    if (fields.length === 0) break;
    const share = Math.ceil((size - maxChars + 1_000) / fields.length);
    for (const k of fields) {
      const value = out[k] as string;
      out[k] = value.slice(0, Math.max(0, value.length - share));
    }
    truncated = true;
  }
  return { doc: out as Document, truncated };
}

/** A failure whose message is shown to the client as-is (no error code prefix). */
class ToolMessageError extends Error {}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

/** Runs a tool body, reporting failures as MCP tool errors with the server's message. */
async function guard(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    if (err instanceof ToolMessageError) return { content: [{ type: "text", text: err.message }], isError: true };
    const e = toAppError(err);
    log.warn("mcp tool failed", { code: e.code, error: e.message });
    return { content: [{ type: "text", text: `${e.code}: ${e.message}` }], isError: true };
  }
}

const INSTRUCTIONS =
  "Web search (SearXNG) and page fetching (Defuddle). Use web_search to find pages, web_fetch to read one page as markdown, web_map to list a site's URLs, web_crawl/web_crawl_status to collect many pages, web_extract for LLM-structured data.";

export function buildServer(engine: Engine): McpServer {
  const server = new McpServer({ name: "sex", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "web_fetch",
    {
      description:
        'Fetch one URL and return its main content as markdown (default). Other formats: "html", "rawHtml", "links", "images", "summary" / {type:"json",prompt,schema} (LLM). Set onlyMainContent:false for the whole page.',
      annotations: { title: "Fetch web page", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      inputSchema: ScrapeRequest,
    },
    (args, ctx) => guard(async () => fetchResult(args, await engine.scrape(args, ctx.mcpReq.signal))),
  );

  server.registerTool(
    "web_search",
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

  server.registerTool(
    "web_map",
    {
      description:
        "List URLs of a website (sitemaps, on-page links and search index) without fetching their content. Use `search` to rank URLs by relevance.",
      annotations: { title: "Map website", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      inputSchema: McpMapRequest,
    },
    (args, ctx) =>
      guard(async () => {
        const links = await engine.map({ ...args, limit: args.limit ?? MCP_MAP_DEFAULT_LIMIT }, ctx.mcpReq.signal);
        return json({ links });
      }),
  );

  server.registerTool(
    "web_crawl",
    {
      description:
        "Start an asynchronous crawl from a URL, following links within the site. Returns a job id; poll it with web_crawl_status. Keep `limit` small.",
      annotations: { title: "Start crawl", readOnlyHint: false, openWorldHint: true, destructiveHint: false },
      inputSchema: McpCrawlRequest,
    },
    (args) =>
      guard(async () => {
        // The tool's default limit sits below prompt-derived and explicit options.
        const job = await engine.crawl(args, { limit: 20 });
        return json({ id: job.id, status: job.status, message: "Crawl started. Use web_crawl_status with this id." });
      }),
  );

  server.registerTool(
    "web_crawl_status",
    {
      description:
        "Get the status and scraped pages of a crawl started with web_crawl. Large results are paginated; pass `skip` from the previous response.",
      annotations: { title: "Crawl status", readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({ id: z.string(), skip: z.number().int().nonnegative().optional() }),
    },
    (args) =>
      guard(async () => {
        const job = await engine.getJob(args.id, "crawl");
        const page = await engine.jobs.store.documents(job.id, args.skip ?? 0, MCP_PAGE_BUDGET_CHARS);
        const fitted = page.data.map((doc) => fitDocument(doc, MCP_PAGE_BUDGET_CHARS));
        const truncated = fitted.some((f) => f.truncated);
        const errors = await engine.jobs.store.errors(job.id);
        return json({
          status: job.status,
          total: job.total,
          completed: job.completed,
          nextSkip: page.nextSkip,
          errors: errors.length,
          data: fitted.map((f) => f.doc),
          ...(truncated ? { truncated: true } : {}),
        });
      }),
  );

  server.registerTool(
    "web_extract",
    {
      description:
        "Extract structured data from one or more URLs with an LLM, following a prompt and/or JSON schema. A trailing /* on a URL covers the whole site. Waits for the result.",
      annotations: { title: "Extract structured data", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      inputSchema: ExtractRequest,
    },
    (args, ctx) =>
      guard(async () => {
        const abortSignal = ctx.mcpReq.signal;
        const { job: started } = await engine.extract(args);
        const deadline = Date.now() + EXTRACT_WAIT_MS;
        let job: JobRecord = started;
        while (job.status === "scraping" && Date.now() < deadline && !abortSignal.aborted) {
          await Bun.sleep(500);
          job = await engine.getJob(started.id, "extract");
        }
        if (job.status === "scraping") await engine.cancelJob(job).catch(() => {});
        if (job.status !== "completed") throw new ToolMessageError(`Extract ${job.status}: ${job.error ?? "timed out"}`);
        return json({ data: job.result, ...(job.sources ? { sources: job.sources } : {}) });
      }),
  );

  return server;
}

/**
 * Serves the tools over stdio. The streamable HTTP transport lives in `src/http/server.ts`, which mounts it at `/mcp`;
 * keep this module free of imports from `../http` so the two do not form a cycle.
 */
export async function serveMcp(engine: Engine): Promise<void> {
  // Never write to stdout: it carries the stdio transport.
  await buildServer(engine).connect(new StdioServerTransport());
  log.info("mcp server on stdio", engine.describe());
}
