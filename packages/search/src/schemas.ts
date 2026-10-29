/** Request/response schemas of search, modelled on the Firecrawl v2 API (see sex-scrape for the scrape ones). */
import { Document, ScrapeOptions } from "@searxng-js/sex-scrape";
import { z } from "zod";

const SourceName = z.enum(["web", "news", "images"]);
const CategoryName = z.enum(["github", "research", "pdf", "developer", "gov"]);

export const SearchRequest = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(100).optional().describe("Max results per source. Defaults to 10 over HTTP, 5 in the CLI and MCP."),
  sources: z
    .array(z.union([SourceName, z.object({ type: SourceName })]))
    .optional()
    .describe('Defaults to ["web"].'),
  categories: z.array(z.union([CategoryName, z.object({ type: CategoryName })])).optional(),
  includeDomains: z.array(z.string()).max(50).optional().describe("At most 50; each one costs a separate SearXNG query"),
  excludeDomains: z.array(z.string()).max(50).optional(),
  tbs: z
    .string()
    .optional()
    .describe(
      "Time filter: qdr:h, qdr:d, qdr:w, qdr:m, qdr:y. qdr:h is treated as qdr:d (SearXNG has no hourly range). Other formats are ignored with a warning.",
    ),
  safe: z.boolean().optional().describe("Strict safe search (SearXNG safesearch=2). Otherwise the instance default applies."),
  location: z.string().optional().describe("Accepted for Firecrawl compatibility; ignored with a warning."),
  country: z.string().optional().describe("Accepted for Firecrawl compatibility; ignored with a warning."),
  lang: z.string().optional().describe("SearXNG language code, e.g. en, zh-CN (extension)"),
  timeout: z.number().int().min(1000).max(300_000).optional().describe("Timeout in milliseconds (1000-300000)"),
  ignoreInvalidURLs: z.boolean().optional().describe("Accepted for Firecrawl compatibility; ignored."),
  zeroDataRetention: z.boolean().optional().describe("Not supported: true returns 501 NOT_SUPPORTED."),
  scrapeOptions: ScrapeOptions.optional().describe("If formats are given, every web/news result is scraped too"),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

export const SearchResultWeb = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  position: z.number().optional(),
  category: z.string().optional(),
});
export const SearchResultNews = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  snippet: z.string().optional(),
  date: z.string().optional(),
  imageUrl: z.string().optional(),
  position: z.number().optional(),
  category: z.string().optional(),
});
export const SearchResultImage = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  imageUrl: z.string().optional(),
  imageWidth: z.number().optional(),
  imageHeight: z.number().optional(),
  position: z.number().optional(),
});

export const SearchData = z.object({
  web: z.array(SearchResultWeb.extend(Document.shape).loose()).optional(),
  news: z.array(SearchResultNews.extend(Document.shape).loose()).optional(),
  images: z.array(SearchResultImage).optional(),
});
export type SearchData = z.infer<typeof SearchData>;

export const SearchResponse = z.object({
  success: z.literal(true),
  id: z.string(),
  creditsUsed: z.number(),
  data: SearchData,
  warning: z.string().optional(),
});
