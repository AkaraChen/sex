import { JSON_SCHEMA_OUTPUT_REGISTRY, ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { badRequest } from "@searxng-js/sex-errors";
import { scrapeUpload } from "@searxng-js/sex-scrape";
import { coreRoutes, procedureBase } from "@searxng-js/sex-server/http/procedures";
import { z } from "zod";
import type { Engine } from "../engine/engine.ts";
import { type JobRecord, PAGE_BUDGET_CHARS } from "../engine/jobs/index.ts";
import {
  ActiveCrawlsResponse,
  BatchScrapeRequest,
  CancelResponse,
  ConcurrencyCheckResponse,
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
  ParseRequest,
  QueueStatusResponse,
  ScrapeOptions,
  ScrapeResponse,
} from "../schemas.ts";

const base = procedureBase<Engine>();

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

/**
 * A job status page carries up to PAGE_BUDGET_CHARS of documents, which the store hands over as JSON text. It is sent
 * as is instead of being parsed, validated and stringified again: oRPC passes a ReadableStream body through untouched
 * when the route's output is "detailed". The OpenAPI document still describes the body as JobStatusResponse.
 */
// Not z.custom, which the converter turns into "never", nor a bare z.unknown(), which makes the body optional.
const RawJobStatusBody = z
  .unknown()
  .refine((v) => v instanceof ReadableStream, "expected a ReadableStream")
  .nonoptional();
type RegistryJsonSchema = Parameters<typeof JSON_SCHEMA_OUTPUT_REGISTRY.add<typeof RawJobStatusBody>>[1];
const [, jobStatusJsonSchema] = new ZodToJsonSchemaConverter().convert(JobStatusResponse, { strategy: "output" });
// @orpc/openapi's JSONSchema type and the registry's are the same JSON Schema, declared twice.
JSON_SCHEMA_OUTPUT_REGISTRY.add(RawJobStatusBody, jobStatusJsonSchema as RegistryJsonSchema);
const RawJobStatusResponse = z.object({ headers: z.record(z.string(), z.string()), body: RawJobStatusBody });

/** Firecrawl's "base domain" test for the few-results hint: the start URL is already the site's root. */
const isSiteRoot = (url: string) => new URL(url).pathname.replace(/\/+$/, "") === "";

/** Hints about a finished job's result (Firecrawl's wording, pointing at sex's own routes). */
async function statusWarning(engine: Engine, job: JobRecord, path: string): Promise<string | undefined> {
  if (job.status === "scraping") return undefined;
  if ((await engine.jobs.store.robotsBlocked(job.id)).length > 0) {
    return `One or more pages could not be crawled because the site's robots.txt disallows them. See the robotsBlocked list on GET ${path}/${job.id}/errors. Set ignoreRobotsTxt: true to crawl them anyway.`;
  }
  if (
    job.kind === "crawl" &&
    job.completed <= 1 &&
    job.url &&
    !isSiteRoot(job.url) &&
    !(job.options as { crawlEntireDomain?: boolean }).crawlEntireDomain
  ) {
    return `Only ${job.completed} result(s) found. For broader coverage, try crawling with crawlEntireDomain=true or start from a higher-level path like ${new URL(job.url).origin}/`;
  }
  return undefined;
}

const jobStatus = async (engine: Engine, kind: JobKind, id: string, skip: number, limit: number | undefined, statusUrl: string) => {
  const job = await engine.getJob(id, kind);
  const { data, nextSkip, cursor } = await engine.jobs.store.documentsJson(id, skip, PAGE_BUDGET_CHARS, limit);
  // A running job may still produce documents, so it always has a next page: the cursor, even when nothing is new yet.
  const next = nextSkip ?? (job.status === "scraping" ? cursor : null);
  const finishedAt = job.finishedAt;
  const warning = await statusWarning(engine, job, new URL(statusUrl).pathname.replace(/\/[^/]+$/, ""));
  const head: Omit<z.input<typeof JobStatusResponse>, "data"> = {
    success: true,
    status: job.status,
    total: job.total,
    completed: job.completed,
    creditsUsed: job.completed,
    expiresAt: new Date(job.expiresAt).toISOString(),
    createdAt: new Date(job.createdAt).toISOString(),
    ...(finishedAt === undefined ? {} : { completedAt: new Date(finishedAt).toISOString() }),
    duration: Math.max(0, (finishedAt ?? Date.now()) - job.createdAt) / 1000,
    ...(job.status === "failed" && job.error ? { error: job.error } : {}),
    ...(warning ? { warning } : {}),
    next: next === null ? null : `${statusUrl}?skip=${next}${limit ? `&limit=${limit}` : ""}`,
  };
  // `{...head,"data":[doc,doc,...]}`
  const parts: Array<string | Uint8Array> = [JSON.stringify(head).slice(0, -1), ',"data":['];
  for (const [i, doc] of data.entries()) {
    if (i > 0) parts.push(",");
    parts.push(doc);
  }
  parts.push("]}");
  const body = new Blob(parts);
  return {
    headers: { "content-type": "application/json", "content-length": String(body.size) },
    body: body.stream(),
  };
};

const cancel = async (engine: Engine, kind: JobKind, id: string) => {
  await engine.cancelJob(await engine.getJob(id, kind));
  return { success: true as const, status: "cancelled" as const };
};

const activeCrawls = async (engine: Engine) => ({
  success: true as const,
  crawls: (await engine.jobs.store.active("crawl")).map((j) => ({
    id: j.id,
    teamId: "local",
    url: j.url ?? "",
    created_at: new Date(j.createdAt).toISOString(),
    options: redactOptions(j.options),
  })),
});

const errorsOf = async (engine: Engine, kind: JobKind, id: string) => {
  await engine.getJob(id, kind);
  const { store } = engine.jobs;
  return { errors: await store.errors(id), robotsBlocked: await store.robotsBlocked(id) };
};

/** The `options` field of an upload: a JSON object in a string, validated like a scrape request's options. */
function parseOptions(raw: string | undefined) {
  if (!raw?.trim()) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw badRequest("The 'options' field must be valid JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw badRequest("The 'options' field must be a JSON object");
  const parsed = ScrapeOptions.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(`Invalid options: ${issue?.path.join(".") || "options"}: ${issue?.message}`);
  }
  return parsed.data;
}

export const router = {
  ...coreRoutes,

  parse: base
    .route({
      method: "POST",
      path: "/v2/parse",
      tags: ["Parse"],
      summary: "Convert an uploaded file (multipart/form-data) to a document",
      inputStructure: "compact",
    })
    .input(ParseRequest)
    .output(ScrapeResponse)
    .handler(async ({ input, context, signal }) => {
      const { document } = await scrapeUpload(context.engine, input.file, parseOptions(input.options), { signal });
      return { success: true as const, data: document };
    }),

  map: base
    .route({ method: "POST", path: "/v2/map", tags: ["Map"], summary: "List the URLs of a website" })
    .input(MapRequest)
    .output(MapResponse)
    .handler(async ({ input, context, signal }) => ({ success: true as const, ...(await context.engine.map(input, signal)) })),

  crawl: {
    start: base
      .route({ method: "POST", path: "/v2/crawl", tags: ["Crawl"], summary: "Start crawling a website" })
      .input(CrawlRequest)
      .output(JobCreatedResponse)
      .handler(async ({ input, context }) => {
        const { job, promptGeneratedOptions } = await context.engine.startCrawl(input);
        return {
          success: true as const,
          id: job.id,
          url: `${context.origin}/v2/crawl/${job.id}`,
          ...(promptGeneratedOptions
            ? { promptGeneratedOptions, finalCrawlerOptions: redactOptions(job.options) as Record<string, unknown> }
            : {}),
        };
      }),
    active: base
      .route({ method: "GET", path: "/v2/crawl/active", tags: ["Crawl"], summary: "List running crawls" })
      .output(ActiveCrawlsResponse)
      .handler(({ context }) => activeCrawls(context.engine)),
    ongoing: base
      .route({ method: "GET", path: "/v2/crawl/ongoing", tags: ["Crawl"], summary: "List running crawls (alias of /v2/crawl/active)" })
      .output(ActiveCrawlsResponse)
      .handler(({ context }) => activeCrawls(context.engine)),
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
      .route({
        method: "GET",
        path: "/v2/crawl/{id}",
        tags: ["Crawl"],
        summary: "Get crawl status and results",
        outputStructure: "detailed",
      })
      .input(JobStatusInput)
      .output(RawJobStatusResponse)
      .handler(({ input, context }) =>
        jobStatus(context.engine, "crawl", input.id, input.skip ?? 0, input.limit, `${context.origin}/v2/crawl/${input.id}`),
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
      .route({
        method: "GET",
        path: "/v2/batch/scrape/{id}",
        tags: ["Batch scrape"],
        summary: "Get batch scrape status and results",
        outputStructure: "detailed",
      })
      .input(JobStatusInput)
      .output(RawJobStatusResponse)
      .handler(({ input, context }) =>
        jobStatus(context.engine, "batch_scrape", input.id, input.skip ?? 0, input.limit, `${context.origin}/v2/batch/scrape/${input.id}`),
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

  concurrencyCheck: base
    .route({ method: "GET", path: "/v2/concurrency-check", tags: ["Team"], summary: "Tasks running now and the concurrency limit" })
    .output(ConcurrencyCheckResponse)
    .handler(async ({ context }) => ({
      success: true as const,
      concurrency: (await context.engine.jobs.queue.counts()).active,
      maxConcurrency: context.engine.config.concurrency,
    })),

  team: {
    queueStatus: base
      .route({ method: "GET", path: "/v2/team/queue-status", tags: ["Team"], summary: "Tasks in the queue" })
      .output(QueueStatusResponse)
      .handler(async ({ context }) => {
        const { store, queue } = context.engine.jobs;
        const { active, waiting } = await queue.counts();
        const last = await store.lastCompletedAt();
        return {
          success: true as const,
          jobsInQueue: active + waiting,
          activeJobsInQueue: active,
          waitingJobsInQueue: waiting,
          maxConcurrency: context.engine.config.concurrency,
          mostRecentSuccess: last === undefined ? null : new Date(last).toISOString(),
        };
      }),
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
          ...(job.warning ? { warning: job.warning } : {}),
          ...(job.sources ? { sources: job.sources } : {}),
          expiresAt: new Date(job.expiresAt).toISOString(),
          creditsUsed: job.completed,
          ...(job.tokensUsed === undefined ? {} : { tokensUsed: job.tokensUsed }),
        };
      }),
  },
};
