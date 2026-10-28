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
  "rawBase64",
  "links",
  "images",
  "screenshot",
  "summary",
  "json",
  "deterministicJson",
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
  model: z.string().optional().describe("Accepted for Firecrawl compatibility; ignored (the model is SEX_LLM_MODEL). Adds a warning."),
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
  country: z.string().optional().describe("ISO 3166-1 alpha-2 country code. Accepted; not used for geo-targeting (adds a warning)."),
  languages: z.array(z.string()).optional().describe("Preferred languages, sent as Accept-Language"),
});

/** `{ type: "pdf" }`; `maxPages`, `pages` and `pageMarkers` are used, the other options are accepted and reported in `warning`. */
const PdfParser = z.strictObject({
  type: z.literal("pdf"),
  maxPages: z.number().int().min(1).max(10_000).optional(),
  mode: z.enum(["fast", "auto", "ocr"]).optional().describe("Accepted; not used."),
  pages: z.boolean().optional().describe("Return the pages one by one in the document's `pages` ({ pageNumber, markdown })."),
  pageMarkdown: z.boolean().optional().describe("Alias of `pages`."),
  blocks: z.boolean().optional().describe("Accepted; not used."),
  pageMarkers: z
    .boolean()
    .optional()
    .describe("Join the pages in `markdown` with a `---` line and `<!-- page N -->` between them (no marker before the first page)."),
  refresh: z.boolean().optional().describe("Accepted; not used (there is no cache)."),
});

export const ScrapeOptions = z
  .object({
    formats: z
      .array(FormatOption)
      .max(20)
      .optional()
      .describe(
        'Output formats. Defaults to ["markdown"]. At most 20. "screenshot", "deterministicJson", "changeTracking", "branding", "product", "menu", "audio" and "video" return 501 NOT_SUPPORTED. "rawBase64" (the file\'s bytes as base64) cannot be combined with other formats.',
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
      .array(z.union([z.enum(["pdf", "image"]), PdfParser, z.strictObject({ type: z.literal("image") })]))
      .max(10)
      .optional()
      .describe(
        'File parsers that may run: "pdf" (optionally { type: "pdf", maxPages }) and "image" (OCR, needs SEX_DOCS). Default: both. Without "pdf" a PDF comes back as base64 in markdown and html.',
      ),
    actions: z.array(Action).max(50).optional().describe("Browser actions run before the page is captured (browser only, at most 50)"),
    location: LocationConfig.optional(),
    removeBase64Images: z.boolean().optional(),
    checkPromptInjection: z
      .boolean()
      .optional()
      .describe("Have the LLM check the page for prompt injection first; a detection fails with 403 SCRAPE_PROMPT_INJECTION_DETECTED"),
    blockAds: z
      .boolean()
      .optional()
      .describe(
        "Block ad and tracker requests (EasyList / EasyPrivacy) while the browser renders the page. Default true; no effect without a browser.",
      ),
    proxy: z
      .enum(["basic", "stealth", "enhanced", "auto"])
      .optional()
      .describe('Every request is fetched directly ("basic"); "stealth" and "enhanced" add a warning.'),
    fastMode: z.boolean().optional().describe("Skip the browser and fetch the page over plain HTTP, so scripts do not run."),
    maxAge: z
      .number()
      .optional()
      .describe(
        "Use a cached copy of the page up to this many ms old (the server default is SEX_CACHE_MAX_AGE_MS, 0 = always fetch; 0 also skips storing). Without a cache (sex-lite) the page is always fetched fresh.",
      ),
    storeInCache: z
      .boolean()
      .optional()
      .describe("Set false to not store this fetch in the cache (default true). No effect without a cache."),
    minAge: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Cache only: return a cached copy at least this many ms old, never fetch; 404 SCRAPE_NO_CACHED_DATA if there is none."),
    lockdown: z.boolean().optional().describe("Cache only: return a cached copy, never fetch; 404 SCRAPE_NO_CACHED_DATA if there is none."),
    redactPII: z
      .union([z.boolean(), z.record(z.string(), z.unknown())])
      .optional()
      .describe("Not supported: true (or options) returns 501 NOT_SUPPORTED."),
    zeroDataRetention: z.boolean().optional().describe("Not supported: true returns 501 NOT_SUPPORTED."),
    onlyCleanContent: z.boolean().optional().describe("Not supported: true returns 501 NOT_SUPPORTED."),
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
    rawBase64: z.string().optional(),
    pages: z
      .array(z.object({ pageNumber: z.number().int(), markdown: z.string() }))
      .optional()
      .describe('The PDF page by page; only with `parsers: [{ type: "pdf", pages: true }]`.'),
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
