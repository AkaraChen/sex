/**
 * The Firecrawl v2 schemas of sex's own endpoints (map, crawl, batch scrape, extract); scrape and search are shared with
 * sex-lite and live in @sex/core.
 */
import { Document, LocationConfig, ScrapeOptions } from "@sex/core/schemas.ts";
import { z } from "zod";

export * from "@sex/core/schemas.ts";

// ---------------------------------------------------------------- parse

/** `multipart/form-data` of `POST /v2/parse`, as Firecrawl takes it: the file, and its scrape options as a JSON string. */
export const ParseRequest = z.object({
  file: z
    .file()
    .describe("The file to convert: a PDF, an office document, a CSV, an image (OCR) or an HTML file. At most SEX_MAX_BODY_BYTES."),
  options: z
    .string()
    .optional()
    .describe('Scrape options as a JSON object string, e.g. {"formats":["markdown"],"parsers":[{"type":"pdf","pages":true}]}.'),
});
export type ParseRequest = z.infer<typeof ParseRequest>;

// ---------------------------------------------------------------- map

export const MapRequest = z.object({
  url: z.string(),
  search: z.string().max(2000).optional().describe("Rank/filter URLs by relevance to this term (max 2000 characters)"),
  sitemap: z.enum(["include", "skip", "only"]).optional().describe('Defaults to "include".'),
  includeSubdomains: z.boolean().optional().describe("Defaults to true."),
  ignoreQueryParameters: z.boolean().optional().describe("Defaults to true."),
  limit: z.number().int().min(1).max(100_000).optional().describe("Defaults to 5000."),
  timeout: z.number().int().min(1000).max(300_000).optional().describe("Timeout in milliseconds (1000-300000)"),
  location: LocationConfig.optional(),
  filterByPath: z.boolean().optional().describe("Only return URLs under the path of the (redirect-resolved) start URL. Defaults to true."),
  includePaths: z.array(z.string()).optional().describe("Regexes matched against the URL path; with any, one of them must match."),
  excludePaths: z.array(z.string()).optional().describe("Regexes matched against the URL path; a match drops the URL."),
  useIndex: z.boolean().optional().describe("Accepted for Firecrawl compatibility and ignored: sex has no URL index."),
  ignoreCache: z.boolean().optional().describe("Accepted for Firecrawl compatibility and ignored: sex has no map cache."),
});
export type MapRequest = z.infer<typeof MapRequest>;

export const MapLink = z.object({ url: z.string(), title: z.string().optional(), description: z.string().optional() });
export type MapLink = z.infer<typeof MapLink>;
export const MapResponse = z.object({
  success: z.literal(true),
  id: z.string().describe("Unique id of this map call."),
  links: z.array(MapLink),
  warning: z.string().optional(),
});
export const MapResult = MapResponse.omit({ success: true });
export type MapResult = z.infer<typeof MapResult>;

// ---------------------------------------------------------------- jobs

/** The header that carries the HMAC of the body (see `SEX_WEBHOOK_SECRET`); sex sets it, a request may not. */
export const WEBHOOK_SIGNATURE_HEADER = "X-Firecrawl-Signature";

export const WebhookConfig = z.union([
  z.string(),
  z.object({
    url: z.string(),
    headers: z
      .record(z.string(), z.string())
      .refine((headers) => !Object.keys(headers).some((name) => name.toLowerCase() === WEBHOOK_SIGNATURE_HEADER.toLowerCase()), {
        message: `The ${WEBHOOK_SIGNATURE_HEADER} header is set by the server and cannot be overridden`,
      })
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    events: z.array(z.enum(["completed", "failed", "page", "started"])).optional(),
  }),
]);
export type WebhookConfig = z.infer<typeof WebhookConfig>;

export const JobStatus = z.enum(["scraping", "completed", "failed", "cancelled"]);

export const CrawlRequest = z.object({
  url: z.string(),
  prompt: z
    .string()
    .max(5000)
    .optional()
    .describe("Natural-language crawl instructions, turned into options by the LLM (max 5000 characters)"),
  includePaths: z.array(z.string().max(1000)).max(100).optional().describe("Regexes; only matching paths are crawled (at most 100)"),
  excludePaths: z.array(z.string().max(1000)).max(100).optional().describe("Regexes; matching paths are skipped (at most 100)"),
  maxDiscoveryDepth: z.number().int().nonnegative().max(100).optional(),
  sitemap: z.enum(["skip", "include", "only"]).optional().describe('Defaults to "include".'),
  ignoreQueryParameters: z.boolean().optional(),
  deduplicateSimilarURLs: z.boolean().optional(),
  regexOnFullURL: z.boolean().optional(),
  limit: z.number().int().positive().max(100_000).optional().describe("Max pages. Defaults to 10000, at most 100000."),
  crawlEntireDomain: z.boolean().optional().describe("Also follow links outside the start URL's path"),
  allowExternalLinks: z.boolean().optional(),
  allowSubdomains: z.boolean().optional(),
  ignoreRobotsTxt: z.boolean().optional(),
  robotsUserAgent: z.string().optional(),
  delay: z
    .number()
    .nonnegative()
    .max(60)
    .optional()
    .describe("Seconds to wait after a page is done before the next one starts (max 60); pages run one at a time"),
  maxConcurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Most pages of this job scraped at once (never more than SEX_CONCURRENCY); delay makes it 1"),
  webhook: WebhookConfig.optional(),
  scrapeOptions: ScrapeOptions.optional(),
});
export type CrawlRequest = z.infer<typeof CrawlRequest>;

export const JobCreatedResponse = z.object({
  success: z.literal(true),
  id: z.string(),
  url: z.string(),
  invalidURLs: z.array(z.string()).optional(),
  promptGeneratedOptions: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Crawl with a `prompt`: the options the LLM derived from it."),
  finalCrawlerOptions: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Crawl with a `prompt`: the options the crawl runs with (header values redacted)."),
});

export const JobIdInput = z.object({ id: z.string() });
export const JobStatusInput = z.object({
  id: z.string(),
  skip: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Return at most this many documents (a page is also capped at 10 MB of JSON)."),
});

export const JobStatusResponse = z.object({
  success: z.literal(true),
  status: JobStatus,
  total: z.number(),
  completed: z.number(),
  creditsUsed: z.number(),
  expiresAt: z.string(),
  createdAt: z.string(),
  completedAt: z.string().optional().describe('When the job left "scraping".'),
  duration: z.number().describe("Seconds from creation to completion (so far, while the job runs)."),
  error: z.string().optional().describe("Why the job failed."),
  warning: z.string().optional(),
  next: z.string().nullable().optional().describe("Always set while the job is scraping, even when there are no new documents yet."),
  data: z.array(Document),
});

export const CancelResponse = z.object({ success: z.literal(true), status: z.literal("cancelled") });

export const JobErrorsResponse = z.object({
  errors: z.array(
    z.object({ id: z.string(), timestamp: z.string().optional(), url: z.string(), error: z.string(), code: z.string().optional() }),
  ),
  robotsBlocked: z.array(z.string()),
});

export const ActiveCrawlsResponse = z.object({
  success: z.literal(true),
  crawls: z.array(z.object({ id: z.string(), teamId: z.string(), url: z.string(), created_at: z.string(), options: z.unknown() })),
});

export const ConcurrencyCheckResponse = z.object({
  success: z.literal(true),
  concurrency: z.number().describe("Tasks running now."),
  maxConcurrency: z.number().describe("SEX_CONCURRENCY."),
});

export const QueueStatusResponse = z.object({
  success: z.literal(true),
  jobsInQueue: z.number().describe("Tasks running or waiting."),
  activeJobsInQueue: z.number(),
  waitingJobsInQueue: z.number().describe("Includes delayed tasks and tasks of lanes at their cap or cooling down."),
  maxConcurrency: z.number(),
  mostRecentSuccess: z.string().nullable().describe("When the last job completed, among the jobs still stored."),
});

export const CrawlParamsPreviewRequest = z.object({ url: z.string(), prompt: z.string() });
export const CrawlParamsPreviewResponse = z.object({ success: z.literal(true), data: z.record(z.string(), z.unknown()) });

export const BatchScrapeRequest = ScrapeOptions.extend({
  urls: z.array(z.string()).min(1).max(10_000),
  ignoreInvalidURLs: z
    .boolean()
    .optional()
    .describe("Skip invalid URLs and list them as `invalidURLs` (default true); false fails the request."),
  maxConcurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Most pages of this job scraped at once (never more than SEX_CONCURRENCY); delay makes it 1"),
  appendToId: z.string().optional(),
  webhook: WebhookConfig.optional(),
});
export type BatchScrapeRequest = z.infer<typeof BatchScrapeRequest>;

export const ExtractRequest = z.object({
  urls: z
    .array(z.string())
    .max(100)
    .optional()
    .describe(
      "URLs to extract from (at most 100); a trailing /* expands to the site's map. Without urls the prompt is searched for on the web.",
    ),
  prompt: z.string().max(20_000).optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  systemPrompt: z.string().max(20_000).optional(),
  enableWebSearch: z
    .boolean()
    .optional()
    .describe("Also search the web for the prompt and add the top 10 results to the urls (with no urls it always does)."),
  allowExternalLinks: z.boolean().optional().describe("Accepted for Firecrawl compatibility; ignored."),
  showSources: z
    .boolean()
    .optional()
    .describe('Adds `sources` to the status: "*" lists the pages used, "products[0]" the pages an array item came from.'),
  ignoreInvalidURLs: z
    .boolean()
    .optional()
    .describe("Skip invalid URLs and list them as `invalidURLs` (default true); false fails the request."),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Most pages a URL ending in /* expands to (default SEX_EXTRACT_WILDCARD_PAGES)."),
  includeSubdomains: z.boolean().optional().describe("Whether a URL ending in /* also expands to subdomains (default true)."),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(3_600_000)
    .optional()
    .describe(
      "Milliseconds the whole extract may take; past it the job fails. Without it only cancelling or SEX_LLM_TIMEOUT per call ends it.",
    ),
  webhook: WebhookConfig.optional().describe("Receives extract.started, extract.completed (with the result) and extract.failed"),
  scrapeOptions: ScrapeOptions.optional(),
});
export type ExtractRequest = z.infer<typeof ExtractRequest>;

export const ExtractCreatedResponse = z.object({ success: z.literal(true), id: z.string(), invalidURLs: z.array(z.string()).optional() });

export const ExtractStatusResponse = z.object({
  success: z.literal(true),
  status: z.enum(["processing", "completed", "failed", "cancelled"]),
  data: z.unknown().optional(),
  error: z.string().optional(),
  warning: z.string().optional(),
  sources: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string(),
  creditsUsed: z.number().optional().describe("Pages the extract read, like a crawl's."),
  tokensUsed: z.number().optional().describe("LLM tokens the run spent (prompt + completion)."),
});
