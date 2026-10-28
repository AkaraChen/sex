/**
 * Request/response schemas, modelled on the Firecrawl v2 API so the official
 * SDKs can talk to this server. Unknown request fields are stripped rather
 * than rejected, so SDK-only fields (origin, integration, ...) are harmless.
 */
import { z } from "zod";

// ---------------------------------------------------------------- formats

export const FORMAT_NAMES = [
  "markdown",
  "html",
  "rawHtml",
  "links",
  "images",
  "screenshot",
  "summary",
  "json",
  "attributes",
  "changeTracking",
  "branding",
  "product",
  "menu",
  "audio",
  "video",
] as const;

const Viewport = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });

export const JsonFormat = z.object({
  type: z.literal("json"),
  prompt: z.string().optional(),
  schema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema the extracted object must match"),
});

export const ScreenshotFormat = z.object({
  type: z.literal("screenshot"),
  fullPage: z.boolean().optional(),
  quality: z.number().int().min(1).max(100).optional(),
  viewport: Viewport.optional(),
});

export const AttributesFormat = z.object({
  type: z.literal("attributes"),
  selectors: z.array(z.object({ selector: z.string(), attribute: z.string() })),
});

export const QuestionFormat = z.object({ type: z.literal("question"), question: z.string() });
export const HighlightsFormat = z.object({ type: z.literal("highlights"), query: z.string() });
const QueryFormat = z.object({ type: z.literal("query"), prompt: z.string(), mode: z.enum(["freeform", "directQuote"]).optional() });
const GenericFormat = z.object({ type: z.enum(FORMAT_NAMES) });

export const FormatOption = z.union([
  z.enum(FORMAT_NAMES),
  // Accepted so they can be rejected with a clear 501 instead of a validation error.
  z.literal("screenshot@fullPage"),
  JsonFormat,
  ScreenshotFormat,
  AttributesFormat,
  QuestionFormat,
  HighlightsFormat,
  QueryFormat,
  GenericFormat,
]);
export type FormatOption = z.infer<typeof FormatOption>;

// ---------------------------------------------------------------- actions

export const Action = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("wait"),
      milliseconds: z.number().int().nonnegative().max(60_000).optional().describe("Milliseconds to wait (max 60000)"),
      selector: z.string().max(1000).optional().describe("CSS selector to wait for; give this or milliseconds, not both"),
    })
    .refine((a) => (a.milliseconds === undefined) !== (a.selector === undefined), {
      message: 'a "wait" action needs exactly one of milliseconds and selector',
    }),
  z.object({ type: z.literal("click"), selector: z.string(), all: z.boolean().optional() }),
  z.object({ type: z.literal("write"), text: z.string() }),
  z.object({ type: z.literal("press"), key: z.string() }),
  z.object({ type: z.literal("scroll"), direction: z.enum(["up", "down"]).default("down"), selector: z.string().optional() }),
  z.object({
    type: z.literal("screenshot"),
    fullPage: z.boolean().optional(),
    quality: z.number().int().optional(),
    viewport: Viewport.optional(),
  }),
  z.object({ type: z.literal("scrape") }),
  z.object({ type: z.literal("executeJavascript"), script: z.string() }),
  z.object({ type: z.literal("pdf"), format: z.string().optional(), landscape: z.boolean().optional(), scale: z.number().optional() }),
]);
export type Action = z.infer<typeof Action>;

// ---------------------------------------------------------------- scrape

/** Most time a request may spend waiting on purpose: `waitFor` plus every `wait` action's `milliseconds` (Firecrawl's limit). */
export const MAX_TOTAL_WAIT_MS = 60_000;

/** Milliseconds a scrape waits on purpose: `waitFor` plus the `wait` actions' `milliseconds` (selector waits end when the element shows up). */
export function totalWaitMs(o: { waitFor?: number; actions?: Action[] }): number {
  let total = o.waitFor ?? 0;
  for (const a of o.actions ?? []) if (a.type === "wait") total += a.milliseconds ?? 0;
  return total;
}

export const LocationConfig = z.object({
  country: z.string().optional().describe("ISO 3166-1 alpha-2 country code. Accepted; not used for geo-targeting."),
  languages: z.array(z.string()).optional().describe("Preferred languages, sent as Accept-Language"),
});

export const ScrapeOptions = z
  .object({
    formats: z
      .array(FormatOption)
      .max(20)
      .optional()
      .describe(
        'Output formats. Defaults to ["markdown"]. At most 20. "screenshot", "changeTracking", "branding", "product", "menu", "audio" and "video" return 501 NOT_SUPPORTED.',
      ),
    onlyMainContent: z.boolean().optional().describe("Return only the main content (Defuddle). Defaults to true."),
    includeTags: z
      .array(z.string().max(1000))
      .max(100)
      .optional()
      .describe("CSS selectors to keep; everything else is dropped (at most 100)"),
    excludeTags: z.array(z.string().max(1000)).max(100).optional().describe("CSS selectors to remove before extraction (at most 100)"),
    headers: z
      .record(z.string(), z.string())
      .refine((h) => Object.keys(h).length <= 50, "at most 50 headers")
      .optional(),
    waitFor: z
      .number()
      .int()
      .nonnegative()
      .max(60_000)
      .optional()
      .describe("Extra milliseconds to wait after load (browser only, max 60000)"),
    mobile: z.boolean().optional(),
    skipTlsVerification: z.boolean().optional(),
    timeout: z.number().int().min(1000).max(300_000).optional().describe("Timeout in milliseconds (1000-300000)"),
    parsers: z
      .array(z.union([z.string(), z.object({ type: z.string(), maxPages: z.number().int().min(1).max(10_000).optional() }).loose()]))
      .max(10)
      .optional()
      .describe(
        'File parsers that may run: "pdf" (optionally { type: "pdf", maxPages }) and "image" (OCR, needs SEX_DOCS). Default: both.',
      ),
    actions: z.array(Action).max(50).optional().describe("Browser actions run before the page is captured (browser only, at most 50)"),
    location: LocationConfig.optional(),
    removeBase64Images: z.boolean().optional(),
    checkPromptInjection: z
      .boolean()
      .optional()
      .describe("Have the LLM check the page for prompt injection first; a detection fails with 403 SCRAPE_PROMPT_INJECTION_DETECTED"),
    blockAds: z.boolean().optional().describe("Accepted for Firecrawl compatibility; ignored."),
    proxy: z.string().optional().describe("Accepted for Firecrawl compatibility; ignored."),
    maxAge: z.number().optional().describe("Accepted for Firecrawl compatibility; ignored (there is no cache)."),
    storeInCache: z.boolean().optional().describe("Accepted for Firecrawl compatibility; ignored."),
  })
  .superRefine((o, ctx) => {
    if (totalWaitMs(o) > MAX_TOTAL_WAIT_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["waitFor"],
        message: `waitFor plus the milliseconds of all wait actions must not exceed ${MAX_TOTAL_WAIT_MS}`,
      });
    }
  });
export type ScrapeOptions = z.infer<typeof ScrapeOptions>;

export const ScrapeRequest = ScrapeOptions.extend({ url: z.string().describe("The URL to scrape") });
export type ScrapeRequest = z.infer<typeof ScrapeRequest>;

export const DocumentMetadata = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    language: z.string().optional(),
    sourceURL: z.string().optional(),
    url: z.string().optional(),
    statusCode: z.number().optional(),
    contentType: z.string().optional(),
    scrapeId: z.string().optional(),
    error: z.string().optional(),
  })
  .loose();

export const ScrapeActionsResult = z.object({
  screenshots: z.array(z.string()),
  scrapes: z.array(z.object({ url: z.string(), html: z.string() })),
  javascriptReturns: z.array(z.object({ type: z.string(), value: z.unknown() })),
  pdfs: z.array(z.string()),
});

export const Document = z
  .object({
    markdown: z.string().optional(),
    html: z.string().optional(),
    rawHtml: z.string().optional(),
    links: z.array(z.string()).optional(),
    images: z.array(z.string()).optional(),
    summary: z.string().optional(),
    json: z.unknown().optional(),
    answer: z.string().optional(),
    highlights: z.string().optional(),
    attributes: z.array(z.object({ selector: z.string(), attribute: z.string(), values: z.array(z.string()) })).optional(),
    actions: ScrapeActionsResult.optional(),
    warning: z.string().optional(),
    metadata: DocumentMetadata.optional(),
  })
  .loose();
export type Document = z.infer<typeof Document>;

export const ScrapeResponse = z.object({ success: z.literal(true), data: Document });

// ---------------------------------------------------------------- search

const SourceName = z.enum(["web", "news", "images"]);
const CategoryName = z.enum(["github", "research", "pdf", "developer", "gov"]);

export const SearchRequest = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(100).optional().describe("Max results per source. Defaults to 5."),
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
    .describe("Time filter: qdr:h, qdr:d, qdr:w, qdr:m, qdr:y. qdr:h is treated as qdr:d (SearXNG has no hourly range)."),
  location: z.string().optional().describe("Accepted for Firecrawl compatibility; ignored."),
  country: z.string().optional().describe("Accepted for Firecrawl compatibility; ignored."),
  lang: z.string().optional().describe("SearXNG language code, e.g. en, zh-CN (extension)"),
  timeout: z.number().int().min(1000).max(300_000).optional().describe("Timeout in milliseconds (1000-300000)"),
  ignoreInvalidURLs: z.boolean().optional().describe("Accepted for Firecrawl compatibility; ignored."),
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

export const SearchResponse = z.object({ success: z.literal(true), data: SearchData, warning: z.string().optional() });
