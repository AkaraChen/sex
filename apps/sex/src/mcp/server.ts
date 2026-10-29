import { McpServer } from "@modelcontextprotocol/server";
import type { JobRecord } from "@searxng-js/sex-jobs";
import { guard, json, registerFetchAndSearch, ToolMessageError } from "@searxng-js/sex-server/mcp/tools";
import { z } from "zod";
import type { Engine } from "../engine/engine.ts";
import { BatchScrapeRequest, CrawlRequest, type Document, ExtractRequest, MapRequest } from "../schemas.ts";
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

const McpExtractRequest = ExtractRequest.extend({
  async: z.boolean().optional().describe("Return the job id at once instead of waiting; poll it with web_extract_status."),
});

const JobId = z.object({ id: z.string() });
const JobPage = JobId.extend({ skip: z.number().int().nonnegative().optional() });

/** firecrawl-mcp's names for the tools it also has; the others keep their `web_` names. */
const FIRECRAWL_NAMES = {
  fetch: "firecrawl_scrape",
  search: "firecrawl_search",
  map: "firecrawl_map",
  crawl: "firecrawl_crawl",
  crawlStatus: "firecrawl_check_crawl_status",
  extract: "firecrawl_extract",
};
const WEB_NAMES = {
  fetch: "web_fetch",
  search: "web_search",
  map: "web_map",
  crawl: "web_crawl",
  crawlStatus: "web_crawl_status",
  extract: "web_extract",
};

const TEXT_FIELDS = ["markdown", "html", "rawHtml"] as const;

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

/** One page of a crawl's or batch scrape's documents, sized for an LLM context. */
async function jobPage(engine: Engine, kind: "crawl" | "batch_scrape", id: string, skip: number | undefined): Promise<string> {
  const job = await engine.getJob(id, kind);
  const page = await engine.jobs.store.documents(job.id, skip ?? 0, MCP_PAGE_BUDGET_CHARS);
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
}

const INSTRUCTIONS =
  "Web search (SearXNG) and page fetching (Defuddle). Use web_search to find pages, web_fetch to read one page as markdown, web_map to list a site's URLs, web_crawl/web_crawl_status/web_crawl_cancel to collect many pages, web_batch_scrape/web_batch_status for a list of URLs, web_extract (async: true + web_extract_status) for LLM-structured data. Tool names are firecrawl-mcp's with SEX_MCP_TOOL_NAMES=firecrawl.";

/**
 * The MCP tools (`web_*`). They are served over streamable HTTP at `/mcp` by `src/http/server.ts`; there is no stdio transport.
 * Keep this module free of imports from `../http` so the two do not form a cycle.
 */
export function buildServer(engine: Engine): McpServer {
  const server = new McpServer({ name: "sex", version: VERSION }, { instructions: INSTRUCTIONS });

  const names = engine.config.mcpToolNames === "firecrawl" ? FIRECRAWL_NAMES : WEB_NAMES;

  registerFetchAndSearch(server, engine, { llmFormats: true, names });

  server.registerTool(
    names.map,
    {
      description:
        "List URLs of a website (sitemaps, on-page links and search index) without fetching their content. Use `search` to rank URLs by relevance.",
      annotations: { title: "Map website", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      inputSchema: McpMapRequest,
    },
    (args, ctx) =>
      guard(async () => {
        const { links, warning } = await engine.map({ ...args, limit: args.limit ?? MCP_MAP_DEFAULT_LIMIT }, ctx.mcpReq.signal);
        return json({ links, ...(warning ? { warning } : {}) });
      }),
  );

  server.registerTool(
    names.crawl,
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
    names.crawlStatus,
    {
      description:
        "Get the status and scraped pages of a crawl started with web_crawl. Large results are paginated; pass `skip` from the previous response.",
      annotations: { title: "Crawl status", readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: JobPage,
    },
    (args) => guard(() => jobPage(engine, "crawl", args.id, args.skip)),
  );

  server.registerTool(
    "web_crawl_cancel",
    {
      description: "Cancel a crawl started with web_crawl. Pages already scraped stay readable with web_crawl_status.",
      annotations: { title: "Cancel crawl", readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: JobId,
    },
    (args) =>
      guard(async () => {
        await engine.cancelJob(await engine.getJob(args.id, "crawl"));
        return json({ id: args.id, status: "cancelled" });
      }),
  );

  server.registerTool(
    "web_batch_scrape",
    {
      description:
        "Start an asynchronous scrape of a list of URLs (same options as web_fetch). Returns a job id; poll it with web_batch_status. Keep the list short.",
      annotations: { title: "Start batch scrape", readOnlyHint: false, openWorldHint: true, destructiveHint: false },
      inputSchema: BatchScrapeRequest,
    },
    (args) =>
      guard(async () => {
        const { job, invalidURLs } = await engine.batchScrape(args);
        return json({
          id: job.id,
          status: job.status,
          ...(invalidURLs ? { invalidURLs } : {}),
          message: "Batch scrape started. Use web_batch_status with this id.",
        });
      }),
  );

  server.registerTool(
    "web_batch_status",
    {
      description:
        "Get the status and scraped pages of a batch scrape started with web_batch_scrape. Large results are paginated; pass `skip` from the previous response.",
      annotations: { title: "Batch scrape status", readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: JobPage,
    },
    (args) => guard(() => jobPage(engine, "batch_scrape", args.id, args.skip)),
  );

  server.registerTool(
    names.extract,
    {
      description:
        "Extract structured data from one or more URLs with an LLM, following a prompt and/or JSON schema. A trailing /* on a URL covers the whole site. Waits for the result unless `async: true`, which returns a job id for web_extract_status.",
      annotations: { title: "Extract structured data", readOnlyHint: false, openWorldHint: true, destructiveHint: false },
      inputSchema: McpExtractRequest,
    },
    (args, ctx) =>
      guard(async () => {
        const { async: detached, ...req } = args;
        const abortSignal = ctx.mcpReq.signal;
        const { job: started, invalidURLs } = await engine.extract(req);
        if (detached) {
          return json({
            id: started.id,
            status: "processing",
            ...(invalidURLs ? { invalidURLs } : {}),
            message: "Extract started. Use web_extract_status with this id.",
          });
        }
        const deadline = Date.now() + EXTRACT_WAIT_MS;
        let job: JobRecord = started;
        while (job.status === "scraping" && Date.now() < deadline && !abortSignal.aborted) {
          await Bun.sleep(500);
          job = await engine.getJob(started.id, "extract");
        }
        if (job.status === "scraping") await engine.cancelJob(job).catch(() => {});
        if (job.status !== "completed") throw new ToolMessageError(`Extract ${job.status}: ${job.error ?? "timed out"}`);
        return json({
          data: job.result,
          ...(job.warning ? { warning: job.warning } : {}),
          ...(job.sources ? { sources: job.sources } : {}),
        });
      }),
  );

  server.registerTool(
    "web_extract_status",
    {
      description: "Get the status and result of an extract started with web_extract and `async: true`.",
      annotations: { title: "Extract status", readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: JobId,
    },
    (args) =>
      guard(async () => {
        const job = await engine.getJob(args.id, "extract");
        return json({
          status: job.status === "scraping" ? "processing" : job.status,
          ...(job.status === "completed" ? { data: job.result } : {}),
          ...(job.error ? { error: job.error } : {}),
          ...(job.warning ? { warning: job.warning } : {}),
          ...(job.sources ? { sources: job.sources } : {}),
        });
      }),
  );

  return server;
}
