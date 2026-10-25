import { FastMCP, UserError } from "fastmcp";
import { z } from "zod";
import type { Engine } from "../core/engine.ts";
import { type JobRecord, PAGE_BUDGET_CHARS } from "../core/jobs/index.ts";
import { toAppError } from "../errors.ts";
import { log } from "../log.ts";
import { CrawlRequest, ExtractRequest, MapRequest, ScrapeRequest, SearchRequest } from "../schemas.ts";
import { VERSION } from "../version.ts";

const EXTRACT_WAIT_MS = 5 * 60 * 1000;

const McpCrawlRequest = CrawlRequest.extend({
  limit: CrawlRequest.shape.limit.describe("Max pages. Defaults to 20 for this tool."),
});

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** Runs a tool body, reporting failures as MCP tool errors with the server's message. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UserError) throw err;
    const e = toAppError(err);
    log.warn("mcp tool failed", { code: e.code, error: e.message });
    throw new UserError(`${e.code}: ${e.message}`);
  }
}

export function createMcpServer(engine: Engine): FastMCP {
  const server = new FastMCP({
    name: "sex",
    version: VERSION as `${number}.${number}.${number}`,
    instructions:
      "Web search (SearXNG) and page fetching (Defuddle). Use web_search to find pages, web_fetch to read one page as markdown, web_map to list a site's URLs, web_crawl/web_crawl_status to collect many pages, web_extract for LLM-structured data.",
    // Never write to stdout: it carries the stdio transport.
    logger: { debug: log.debug, info: log.info, log: log.info, warn: log.warn, error: log.error },
  });

  server.addTool({
    name: "web_fetch",
    description:
      'Fetch one URL and return its main content as markdown (default). Other formats: "html", "rawHtml", "links", "images", "summary" / {type:"json",prompt,schema} (LLM). Set onlyMainContent:false for the whole page.',
    annotations: { title: "Fetch web page", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    parameters: ScrapeRequest,
    execute: (args, { signal: abortSignal }) =>
      guard(async () => {
        return json(await engine.scrape(args, abortSignal));
      }),
  });

  server.addTool({
    name: "web_search",
    description:
      'Search the web. Returns ranked results (url, title, description) grouped by source ("web", "news", "images"). Add scrapeOptions:{formats:["markdown"]} to also fetch each result\'s content; usually prefer web_fetch on the few URLs you need.',
    annotations: { title: "Web search", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    parameters: SearchRequest,
    execute: (args, { signal: abortSignal }) =>
      guard(async () => {
        const { data, warning } = await engine.search(args, abortSignal);
        return json(warning ? { ...data, warning } : data);
      }),
  });

  server.addTool({
    name: "web_map",
    description:
      "List URLs of a website (sitemaps, on-page links and search index) without fetching their content. Use `search` to rank URLs by relevance.",
    annotations: { title: "Map website", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    parameters: MapRequest,
    execute: (args, { signal: abortSignal }) => guard(async () => json({ links: await engine.map(args, abortSignal) })),
  });

  server.addTool({
    name: "web_crawl",
    description:
      "Start an asynchronous crawl from a URL, following links within the site. Returns a job id; poll it with web_crawl_status. Keep `limit` small.",
    annotations: { title: "Start crawl", readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    parameters: McpCrawlRequest,
    execute: (args) =>
      guard(async () => {
        // The tool's default limit sits below prompt-derived and explicit options.
        const job = await engine.crawl(args, { limit: 20 });
        return json({ id: job.id, status: job.status, message: "Crawl started. Use web_crawl_status with this id." });
      }),
  });

  server.addTool({
    name: "web_crawl_status",
    description:
      "Get the status and scraped pages of a crawl started with web_crawl. Large results are paginated; pass `skip` from the previous response.",
    annotations: { title: "Crawl status", readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    parameters: z.object({ id: z.string(), skip: z.number().int().nonnegative().optional() }),
    execute: (args) =>
      guard(async () => {
        const job = await engine.getJob(args.id, "crawl");
        const { data, nextSkip } = await engine.jobs.store.documents(job.id, args.skip ?? 0, PAGE_BUDGET_CHARS);
        const errors = await engine.jobs.store.errors(job.id);
        return json({ status: job.status, total: job.total, completed: job.completed, nextSkip, errors: errors.length, data });
      }),
  });

  server.addTool({
    name: "web_extract",
    description:
      "Extract structured data from one or more URLs with an LLM, following a prompt and/or JSON schema. A trailing /* on a URL covers the whole site. Waits for the result.",
    annotations: { title: "Extract structured data", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    parameters: ExtractRequest,
    execute: (args, { signal: abortSignal }) =>
      guard(async () => {
        const { job: started } = await engine.extract(args);
        const deadline = Date.now() + EXTRACT_WAIT_MS;
        let job: JobRecord = started;
        while (job.status === "scraping" && Date.now() < deadline && !abortSignal?.aborted) {
          await Bun.sleep(500);
          job = await engine.getJob(started.id, "extract");
        }
        if (job.status === "scraping") await engine.cancelJob(job).catch(() => {});
        if (job.status !== "completed") throw new UserError(`Extract ${job.status}: ${job.error ?? "timed out"}`);
        return json({ data: job.result, ...(job.sources ? { sources: job.sources } : {}) });
      }),
  });

  return server;
}

export async function serveMcp(engine: Engine, opts: { transport: "stdio" | "http"; port: number; host: string; stateless: boolean }) {
  const server = createMcpServer(engine);
  if (opts.transport === "stdio") {
    await server.start({ transportType: "stdio" });
    log.info("mcp server on stdio", engine.describe());
  } else {
    await server.start({
      transportType: "httpStream",
      httpStream: { port: opts.port, host: opts.host, endpoint: "/mcp", stateless: opts.stateless },
    });
    log.info("mcp server listening", { url: `http://${opts.host}:${opts.port}/mcp`, ...engine.describe() });
  }
  return server;
}
