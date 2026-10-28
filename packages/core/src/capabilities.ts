import type { Deadline } from "./deadline.ts";
import type { PageExtractOptions, PageExtractResult } from "./page.ts";
import type { Action } from "./schemas.ts";

/**
 * What a scrape can do beyond plain HTTP + Defuddle. sex provides all three (Lightpanda / CDP, an OpenAI-compatible LLM,
 * here-docs); sex-lite none. `scrapeUrl` fails with browserRequired() / llmRequired() for options that need a missing one.
 */

/** Most page characters the injection guard scans; a page past it is cut, so nothing unscanned reaches the LLM (Firecrawl: 2M). */
export const GUARD_MAX_CHARS = 2_000_000;

// ---------------------------------------------------------------- browser

export interface BrowserScrapeOptions {
  url: string;
  /**
   * Bounds everything the browser does for this page: waiting for a slot, loading, `waitFor`, actions and the page script.
   * When it ends the page's browser context is closed, which frees the slot at once.
   */
  deadline: Deadline;
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
  /** Checked for every request the browser makes (documents, redirects, subresources). Resolves true when allowed. */
  requestGuard?: (url: string) => Promise<boolean>;
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
  checkInjection(markdown: string, deadline: Deadline): Promise<{ scannedFully: boolean }>;
  extractJson(
    content: string,
    opts: { prompt?: string; schema?: Record<string, unknown>; url?: string },
    deadline: Deadline,
  ): Promise<unknown>;
  summarize(content: string, deadline: Deadline, url?: string): Promise<string>;
  answer(content: string, question: string, deadline: Deadline, url?: string): Promise<string>;
  selectLines(content: string, query: string, purpose: "highlights" | "answer", deadline: Deadline, url?: string): Promise<string>;
}

// ---------------------------------------------------------------- documents

export interface DocsWarning {
  code: string;
  message: string;
}

export interface DocsResult {
  markdown: string;
  /** Pages in the whole document, for paged inputs (PDF). */
  numPages?: number;
  /** Pages actually converted; less than numPages when maxPages stopped early. */
  pagesConverted?: number;
  warnings: DocsWarning[];
}

export interface DocsConvertOptions {
  /** Format hint for inputs without a signature (e.g. CSV); never read as a path. */
  filename?: string;
  /** Stop after this many pages. */
  maxPages?: number;
  /** Bounds the conversion; when it ends the conversion is aborted and the error is the deadline's. */
  deadline: Deadline;
}

export interface ScrapeDocs {
  readonly enabled: boolean;
  convert(body: Uint8Array, opts: DocsConvertOptions): Promise<DocsResult>;
}
