import type { PageExtractOptions, PageExtractResult, PdfPage } from "@searxng-js/sex-page";
import type { CallTime } from "./deadline.ts";
import type { Action, ChangeTrackingResult } from "./schemas.ts";

/**
 * What a scrape can do beyond plain HTTP + Defuddle. sex provides all three (Lightpanda / CDP, an OpenAI-compatible LLM,
 * here-docs), a page cache and change tracking; sex-lite none. `scrapeUrl` fails with browserRequired() / llmRequired() for options that need a
 * missing one, and without a cache `lockdown` / `minAge` are 404s.
 */

/** Most page characters the injection guard scans; a page past it is cut, so nothing unscanned reaches the LLM (Firecrawl: 2M). */
export const GUARD_MAX_CHARS = 2_000_000;

// ---------------------------------------------------------------- browser

export interface BrowserScrapeOptions extends CallTime {
  url: string;
  /**
   * `signal` and `deadlineAt` bound everything the browser does for this page: waiting for a slot, loading, `waitFor`,
   * actions and the page script. When they end the page's browser context is closed, which frees the slot at once.
   */
  /**
   * Sent with the page's requests. `Authorization` / `Proxy-Authorization` reach the target's origin only, `Cookie` is stored as
   * host-only cookies of the target's host; everything else goes to every request (see browser-policy.ts).
   */
  headers?: Record<string, string>;
  userAgent: string;
  mobile?: boolean;
  waitFor?: number;
  actions?: Action[];
  extract: Omit<PageExtractOptions, "url">;
  /** Accept invalid TLS certificates (Chrome only; CDP Security.setIgnoreCertificateErrors). */
  skipTlsVerification?: boolean;
  /** Abort requests to ad and tracker domains (EasyList / EasyPrivacy). The browser may not support it. */
  blockAds?: boolean;
}

export interface BrowserScrapeResult {
  url: string;
  status: number;
  contentType: string;
  /** Set when the response is not HTML; the caller should re-fetch over plain HTTP. */
  nonHtml?: boolean;
  rawHtml: string;
  /** Requests aborted as ads or trackers. */
  adsBlocked?: number;
  extracted?: PageExtractResult;
  actions?: {
    screenshots: string[];
    scrapes: Array<{ url: string; html: string }>;
    javascriptReturns: Array<{ type: string; value: unknown }>;
    pdfs: string[];
  };
}

export interface ScrapeBrowser {
  readonly enabled: boolean;
  scrape(opts: BrowserScrapeOptions): Promise<BrowserScrapeResult>;
}

// ---------------------------------------------------------------- LLM

export interface ScrapeLlm {
  readonly enabled: boolean;
  /** Most page characters sent in one call. */
  readonly maxInputChars: number;
  /** Throws BAD_REQUEST for a JSON Schema the `json` format cannot use. */
  checkSchema(schema: Record<string, unknown>): void;
  fit(content: string): { text: string; truncated: boolean };
  checkInjection(markdown: string, time: CallTime): Promise<{ scannedFully: boolean }>;
  extractJson(content: string, opts: { prompt?: string; schema?: Record<string, unknown>; url?: string }, time: CallTime): Promise<unknown>;
  summarize(content: string, time: CallTime, url?: string): Promise<string>;
  answer(content: string, question: string, time: CallTime, url?: string): Promise<string>;
  selectLines(content: string, query: string, purpose: "highlights" | "answer", time: CallTime, url?: string): Promise<string>;
  /** What changed between two versions of a page, as a JSON value (change tracking `json` mode without a schema). */
  describeChanges(previous: string, current: string, opts: { prompt?: string; url?: string }, time: CallTime): Promise<unknown>;
}

// ---------------------------------------------------------------- documents

export interface DocsWarning {
  code: string;
  message: string;
}

export interface DocsResult {
  markdown: string;
  /**
   * The converted pages in order, empty ones included; absent when the input is not paged or the converter returned something
   * that belongs to no page (so `markdown` cannot be rebuilt from it).
   */
  pages?: PdfPage[];
  /** Pages in the whole document, for paged inputs (PDF). */
  numPages?: number;
  /** Pages actually converted; less than numPages when maxPages stopped early. */
  pagesConverted?: number;
  warnings: DocsWarning[];
}

/** `signal` and `deadlineAt` bound the conversion: when they end it is aborted (a converter may take the time left as its budget). */
export interface DocsConvertOptions extends CallTime {
  /** Format hint for inputs without a signature (e.g. CSV); never read as a path. */
  filename?: string;
  /** Stop after this many pages. */
  maxPages?: number;
}

export interface ScrapeDocs {
  readonly enabled: boolean;
  convert(body: Uint8Array, opts: DocsConvertOptions): Promise<DocsResult>;
}

// ---------------------------------------------------------------- page cache

/** What is looked up: the fetched URL and everything else that changes the stored bytes (`scrape.ts` `cacheVariant`). */
export interface CacheKey {
  url: string;
  variant: string;
}

/**
 * What a scrape fetched, before extraction: the HTTP response body, or for a browser scrape the rendered HTML (UTF-8).
 * Formats, selectors and LLM options are applied on top, so one entry serves every request for the page.
 */
export interface CachedPage {
  /** The URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: Uint8Array;
}

/**
 * A store of fetched pages, `maxAge` / `storeInCache` / `minAge` / `lockdown`. sex provides one (SQLite under SEX_DATA_DIR);
 * sex-lite none, where `lockdown` / `minAge` are 404s. `scrapeUrl` decides what may be cached; the store only keeps bytes
 * and drops what is old or over its size limit.
 */
export interface ScrapeCache {
  /** The `maxAge` of a request that has none (SEX_CACHE_MAX_AGE_MS); 0 skips the cache. */
  readonly defaultMaxAge: number;
  /** Entries older than this are gone; it is the `maxAge` of a cache-only request (`lockdown` / `minAge`) that gives none. */
  readonly retention: number;
  /** The entry stored between `minAge` and `maxAge` ms ago, if any. */
  get(key: CacheKey, age: { minAge?: number; maxAge: number }): Promise<(CachedPage & { storedAt: number }) | undefined>;
  /** Never throws: a cache that cannot store is a miss next time. */
  put(key: CacheKey, page: CachedPage): Promise<void>;
}

// ---------------------------------------------------------------- change tracking

/** The last markdown scraped for a `(url, tag)`. */
export interface TrackedPage {
  markdown: string;
  /** When it was scraped (ms since the epoch). */
  scrapedAt: number;
}

/**
 * What the `changeTracking` format compares against: the markdown of the previous scrape of a URL, kept per tag. sex provides
 * one (SQLite under SEX_DATA_DIR); sex-lite none, where the format is a 501. Unlike `ScrapeCache` an entry is the only copy of
 * something that cannot be fetched again, so it never expires and is never evicted: a new scrape replaces it.
 */
export interface ChangeTracker {
  /** The stored scrape of `url` under `tag` (null = untagged), if any. Throws when the store cannot be read. */
  get(url: string, tag: string | null): Promise<TrackedPage | undefined>;
  /** Replaces the stored scrape. Throws when it cannot be stored. */
  put(url: string, tag: string | null, markdown: string, scrapedAt: number): Promise<void>;
  /** The unified diff of two versions (`git-diff` mode), within the time `deadlineAt` leaves; undefined when there is no line to report or it took too long. */
  diff(previous: string, current: string, time: CallTime): NonNullable<ChangeTrackingResult["diff"]> | undefined;
}
