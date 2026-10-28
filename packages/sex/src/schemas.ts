/**
 * The Firecrawl v2 schemas of sex's own endpoints (map, crawl, batch scrape, extract); scrape and search are shared with
 * sex-lite and live in @sex/core.
 */
import { Document, LocationConfig, ScrapeOptions } from "@sex/core/schemas.ts";
import { z } from "zod";

export * from "@sex/core/schemas.ts";

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
});
export type MapRequest = z.infer<typeof MapRequest>;

export const MapLink = z.object({ url: z.string(), title: z.string().optional(), description: z.string().optional() });
export type MapLink = z.infer<typeof MapLink>;
export const MapResponse = z.object({ success: z.literal(true), links: z.array(MapLink) });

// ---------------------------------------------------------------- jobs

export const WebhookConfig = z.union([
  z.string(),
  z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
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
  delay: z.number().nonnegative().max(60).optional().describe("Seconds between page fetches (max 60)"),
  maxConcurrency: z.number().int().positive().optional().describe("Accepted; concurrency is set per server (SEX_CONCURRENCY)."),
  webhook: WebhookConfig.optional(),
  scrapeOptions: ScrapeOptions.optional(),
});
export type CrawlRequest = z.infer<typeof CrawlRequest>;

export const JobCreatedResponse = z.object({
  success: z.literal(true),
  id: z.string(),
  url: z.string(),
  invalidURLs: z.array(z.string()).optional(),
});

export const JobIdInput = z.object({ id: z.string() });
export const JobStatusInput = z.object({ id: z.string(), skip: z.coerce.number().int().nonnegative().optional() });

export const JobStatusResponse = z.object({
  success: z.literal(true),
  status: JobStatus,
  total: z.number(),
  completed: z.number(),
  creditsUsed: z.number(),
  expiresAt: z.string(),
  next: z.string().nullable().optional(),
  data: z.array(Document),
});

export const CancelResponse = z.object({ success: z.literal(true), status: z.literal("cancelled") });

export const JobErrorsResponse = z.object({
  errors: z.array(z.object({ id: z.string(), timestamp: z.string().optional(), url: z.string(), error: z.string() })),
  robotsBlocked: z.array(z.string()),
});

export const ActiveCrawlsResponse = z.object({
  success: z.literal(true),
  crawls: z.array(z.object({ id: z.string(), teamId: z.string(), url: z.string(), options: z.unknown() })),
});

export const CrawlParamsPreviewRequest = z.object({ url: z.string(), prompt: z.string() });
export const CrawlParamsPreviewResponse = z.object({ success: z.literal(true), data: z.record(z.string(), z.unknown()) });

export const BatchScrapeRequest = ScrapeOptions.extend({
  urls: z.array(z.string()).min(1).max(10_000),
  ignoreInvalidURLs: z.boolean().optional(),
  maxConcurrency: z.number().int().positive().optional().describe("Accepted; concurrency is set per server (SEX_CONCURRENCY)."),
  appendToId: z.string().optional(),
  webhook: WebhookConfig.optional(),
});
export type BatchScrapeRequest = z.infer<typeof BatchScrapeRequest>;

export const ExtractRequest = z.object({
  urls: z.array(z.string()).max(100).optional().describe("URLs to extract from (at most 100); a trailing /* expands to the site's map"),
  prompt: z.string().max(20_000).optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  systemPrompt: z.string().max(20_000).optional(),
  enableWebSearch: z.boolean().optional().describe("Also search the web for the prompt and include top results"),
  allowExternalLinks: z.boolean().optional().describe("Accepted for Firecrawl compatibility; ignored."),
  showSources: z.boolean().optional(),
  ignoreInvalidURLs: z.boolean().optional(),
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
  creditsUsed: z.number().optional(),
});
