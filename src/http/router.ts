import { ORPCError, os } from "@orpc/server";
import type { Engine } from "../core/engine.ts";
import { PAGE_BUDGET_CHARS } from "../core/jobs/index.ts";
import { toAppError } from "../errors.ts";
import { log } from "../log.ts";
import {
  ActiveCrawlsResponse,
  BatchScrapeRequest,
  CancelResponse,
  CrawlParamsPreviewRequest,
  CrawlParamsPreviewResponse,
  CrawlRequest,
  ExtractCreatedResponse,
  ExtractRequest,
  ExtractStatusResponse,
  JobCreatedResponse,
  JobErrorsResponse,
  JobIdInput,
  JobStatusInput,
  JobStatusResponse,
  MapRequest,
  MapResponse,
  ScrapeRequest,
  ScrapeResponse,
  SearchRequest,
  SearchResponse,
} from "../schemas.ts";

export interface HttpContext {
  engine: Engine;
  /** Public origin of this server, used to build job status URLs. */
  origin: string;
}

/** Turns AppErrors into oRPC errors so the response carries the right status and body. */
const base = os.$context<HttpContext>().use(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    if (err instanceof ORPCError) throw err;
    const e = toAppError(err);
    if (e.status >= 500) {
      log.error("request failed", { code: e.code, error: e.message, stack: err instanceof Error ? err.stack : undefined });
    }
    throw new ORPCError(e.code, { status: e.status, message: e.message, data: e.details });
  }
});

type JobKind = "crawl" | "batch_scrape" | "extract";

const REDACTED = "[redacted]";

/** Copies stored job options with every header value replaced, so credentials never leave the server. */
function redactOptions(options: unknown): unknown {
  if (!options || typeof options !== "object") return options;
  const copy = structuredClone(options) as Record<string, unknown>;
  const redactHeaders = (holder: unknown) => {
    if (!holder || typeof holder !== "object") return;
    const record = holder as Record<string, unknown>;
    const headers = record.headers;
    if (headers && typeof headers === "object") {
      record.headers = Object.fromEntries(Object.keys(headers).map((name) => [name, REDACTED]));
    }
  };
  redactHeaders(copy);
  redactHeaders(copy.scrapeOptions);
  redactHeaders(copy.webhook);
  return copy;
}

const jobStatus = async (engine: Engine, kind: JobKind, id: string, skip: number, statusUrl: string) => {
  const job = await engine.getJob(id, kind);
  const { data, nextSkip } = await engine.jobs.store.documents(id, skip, PAGE_BUDGET_CHARS);
  return {
    success: true as const,
    status: job.status,
    total: job.total,
    completed: job.completed,
    creditsUsed: job.completed,
    expiresAt: new Date(job.expiresAt).toISOString(),
    next: nextSkip === null ? null : `${statusUrl}?skip=${nextSkip}`,
    data,
  };
};

const cancel = async (engine: Engine, kind: JobKind, id: string) => {
  await engine.cancelJob(await engine.getJob(id, kind));
  return { success: true as const, status: "cancelled" as const };
};

const errorsOf = async (engine: Engine, kind: JobKind, id: string) => {
  await engine.getJob(id, kind);
  const { store } = engine.jobs;
  return { errors: await store.errors(id), robotsBlocked: await store.robotsBlocked(id) };
};

export const router = {
  scrape: base
    .route({ method: "POST", path: "/v2/scrape", tags: ["Scrape"], summary: "Scrape a single URL" })
    .input(ScrapeRequest)
    .output(ScrapeResponse)
    .handler(async ({ input, context, signal }) => ({ success: true as const, data: await context.engine.scrape(input, signal) })),

  search: base
    .route({ method: "POST", path: "/v2/search", tags: ["Search"], summary: "Search the web via SearXNG, optionally scraping results" })
    .input(SearchRequest)
    .output(SearchResponse)
    .handler(async ({ input, context, signal }) => {
      const { data, warning } = await context.engine.search(input, signal);
      return { success: true as const, data, ...(warning ? { warning } : {}) };
    }),

  map: base
    .route({ method: "POST", path: "/v2/map", tags: ["Map"], summary: "List the URLs of a website" })
    .input(MapRequest)
    .output(MapResponse)
    .handler(async ({ input, context, signal }) => ({ success: true as const, links: await context.engine.map(input, signal) })),

  crawl: {
    start: base
      .route({ method: "POST", path: "/v2/crawl", tags: ["Crawl"], summary: "Start crawling a website" })
      .input(CrawlRequest)
      .output(JobCreatedResponse)
      .handler(async ({ input, context }) => {
        const job = await context.engine.crawl(input);
        return { success: true as const, id: job.id, url: `${context.origin}/v2/crawl/${job.id}` };
      }),
    active: base
      .route({ method: "GET", path: "/v2/crawl/active", tags: ["Crawl"], summary: "List running crawls" })
      .output(ActiveCrawlsResponse)
      .handler(async ({ context }) => ({
        success: true as const,
        crawls: (await context.engine.jobs.store.active("crawl")).map((j) => ({
          id: j.id,
          teamId: "local",
          url: j.url ?? "",
          options: redactOptions(j.options),
        })),
      })),
    paramsPreview: base
      .route({
        method: "POST",
        path: "/v2/crawl/params-preview",
        tags: ["Crawl"],
        summary: "Preview crawl options derived from a prompt (LLM)",
      })
      .input(CrawlParamsPreviewRequest)
      .output(CrawlParamsPreviewResponse)
      .handler(async ({ input, context }) => ({
        success: true as const,
        data: { url: input.url, ...(await context.engine.crawlParamsPreview(input.url, input.prompt)) },
      })),
    status: base
      .route({ method: "GET", path: "/v2/crawl/{id}", tags: ["Crawl"], summary: "Get crawl status and results" })
      .input(JobStatusInput)
      .output(JobStatusResponse)
      .handler(({ input, context }) =>
        jobStatus(context.engine, "crawl", input.id, input.skip ?? 0, `${context.origin}/v2/crawl/${input.id}`),
      ),
    cancel: base
      .route({ method: "DELETE", path: "/v2/crawl/{id}", tags: ["Crawl"], summary: "Cancel a crawl" })
      .input(JobIdInput)
      .output(CancelResponse)
      .handler(({ input, context }) => cancel(context.engine, "crawl", input.id)),
    errors: base
      .route({ method: "GET", path: "/v2/crawl/{id}/errors", tags: ["Crawl"], summary: "Get crawl errors" })
      .input(JobIdInput)
      .output(JobErrorsResponse)
      .handler(({ input, context }) => errorsOf(context.engine, "crawl", input.id)),
  },

  batchScrape: {
    start: base
      .route({ method: "POST", path: "/v2/batch/scrape", tags: ["Batch scrape"], summary: "Scrape many URLs asynchronously" })
      .input(BatchScrapeRequest)
      .output(JobCreatedResponse)
      .handler(async ({ input, context }) => {
        const { job, invalidURLs } = await context.engine.batchScrape(input);
        return {
          success: true as const,
          id: job.id,
          url: `${context.origin}/v2/batch/scrape/${job.id}`,
          ...(invalidURLs ? { invalidURLs } : {}),
        };
      }),
    status: base
      .route({ method: "GET", path: "/v2/batch/scrape/{id}", tags: ["Batch scrape"], summary: "Get batch scrape status and results" })
      .input(JobStatusInput)
      .output(JobStatusResponse)
      .handler(({ input, context }) =>
        jobStatus(context.engine, "batch_scrape", input.id, input.skip ?? 0, `${context.origin}/v2/batch/scrape/${input.id}`),
      ),
    cancel: base
      .route({ method: "DELETE", path: "/v2/batch/scrape/{id}", tags: ["Batch scrape"], summary: "Cancel a batch scrape" })
      .input(JobIdInput)
      .output(CancelResponse)
      .handler(({ input, context }) => cancel(context.engine, "batch_scrape", input.id)),
    errors: base
      .route({ method: "GET", path: "/v2/batch/scrape/{id}/errors", tags: ["Batch scrape"], summary: "Get batch scrape errors" })
      .input(JobIdInput)
      .output(JobErrorsResponse)
      .handler(({ input, context }) => errorsOf(context.engine, "batch_scrape", input.id)),
  },

  extract: {
    start: base
      .route({ method: "POST", path: "/v2/extract", tags: ["Extract"], summary: "Extract structured data from pages with an LLM" })
      .input(ExtractRequest)
      .output(ExtractCreatedResponse)
      .handler(async ({ input, context }) => {
        const { job, invalidURLs } = await context.engine.extract(input);
        return { success: true as const, id: job.id, ...(invalidURLs ? { invalidURLs } : {}) };
      }),
    status: base
      .route({ method: "GET", path: "/v2/extract/{id}", tags: ["Extract"], summary: "Get extract status and result" })
      .input(JobIdInput)
      .output(ExtractStatusResponse)
      .handler(async ({ input, context }) => {
        const job = await context.engine.getJob(input.id, "extract");
        return {
          success: true as const,
          status: job.status === "scraping" ? ("processing" as const) : job.status,
          ...(job.status === "completed" ? { data: job.result } : {}),
          ...(job.error ? { error: job.error } : {}),
          ...(job.sources ? { sources: job.sources } : {}),
          expiresAt: new Date(job.expiresAt).toISOString(),
        };
      }),
  },
};
