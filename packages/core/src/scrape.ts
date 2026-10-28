import { randomUUID } from "node:crypto";
import type { LimitFunction } from "p-limit";
import {
  type BrowserScrapeResult,
  type CachedPage,
  type CacheKey,
  type ChangeTracker,
  GUARD_MAX_CHARS,
  type ScrapeBrowser,
  type ScrapeCache,
  type ScrapeDocs,
  type ScrapeLlm,
} from "./capabilities.ts";
import { type ChangeTrackingRequest, trackChanges } from "./change-tracking.ts";
import type { CoreConfig } from "./config.ts";
import { Deadline } from "./deadline.ts";
import { AppError, badRequest, browserRequired, CHANGE_TRACKING_HINT, isBlocked, llmRequired, toAppError, unsupported } from "./errors.ts";
import type { ExtractPool } from "./extract-pool.ts";
import { log } from "./log.ts";
import { markdownToHtml } from "./markdown-html.ts";
import { assertPublicUrl, decodeBody, type FetchedResponse, MARKUP_TYPE, parseHttpUrl, safeFetch } from "./net.ts";
import type { PageExtractResult } from "./page.ts";
import { joinPages, type PdfPage } from "./pdf.ts";
import { fileKindOf, rewriteUrl } from "./rewrite.ts";
import type { Document, FormatOption, ScrapeOptions } from "./schemas.ts";

/** What a scrape runs on. The optional capabilities are used only when present and `enabled`. */
export interface ScrapeContext {
  readonly config: CoreConfig;
  /** Global cap on concurrent scrapes (SEX_CONCURRENCY). */
  readonly scrapeLimit: LimitFunction;
  readonly extractPool: ExtractPool;
  readonly browser?: ScrapeBrowser;
  readonly llm?: ScrapeLlm;
  readonly docs?: ScrapeDocs;
  /** Fetched pages kept for `maxAge`; without one nothing is read or stored, and `lockdown` / `minAge` are 404s. */
  readonly cache?: ScrapeCache;
  /** The previous scrape of a page, for the `changeTracking` format; without one the format is a 501. */
  readonly changeTracker?: ChangeTracker;
  /** How to get a missing browser or LLM, for the 501 errors; defaults to sex's flags. */
  readonly missingHints?: MissingHints;
}

export interface MissingHints {
  browser?: string;
  llm?: string;
  changeTracking?: string;
}

export interface NormalizedFormats {
  markdown: boolean;
  html: boolean;
  rawHtml: boolean;
  /** The file's bytes as base64; the only format of its request. */
  rawBase64: boolean;
  links: boolean;
  images: boolean;
  summary: boolean;
  json?: { prompt?: string; schema?: Record<string, unknown> };
  attributes?: Array<{ selector: string; attribute: string }>;
  question?: string;
  /** `query` format mode: "directQuote" answers with verbatim page lines. */
  questionMode?: "freeform" | "directQuote";
  highlights?: string;
  changeTracking?: ChangeTrackingRequest;
}

const UNSUPPORTED_FORMATS = new Set([
  "screenshot",
  "screenshot@fullPage",
  "deterministicJson",
  "branding",
  "product",
  "menu",
  "audio",
  "video",
]);

export function normalizeFormats(formats: FormatOption[] | undefined): NormalizedFormats {
  const out: NormalizedFormats = {
    markdown: false,
    html: false,
    rawHtml: false,
    rawBase64: false,
    links: false,
    images: false,
    summary: false,
  };
  const list = formats?.length ? formats : ["markdown" as const];
  for (const f of list) {
    const type = typeof f === "string" ? f : f.type;
    if (UNSUPPORTED_FORMATS.has(type)) throw unsupported(`The "${type}" format`);
    switch (type) {
      case "markdown":
      case "html":
      case "rawHtml":
      case "rawBase64":
      case "links":
      case "images":
      case "summary":
        out[type] = true;
        break;
      case "json": {
        const jf = typeof f === "string" ? {} : (f as { prompt?: string; schema?: Record<string, unknown> });
        out.json = { prompt: jf.prompt, schema: jf.schema };
        break;
      }
      case "attributes":
        out.attributes = typeof f === "string" ? [] : (f as { selectors: NormalizedFormats["attributes"] }).selectors;
        break;
      case "question":
        out.question = (f as { question: string }).question;
        break;
      case "highlights":
        out.highlights = (f as { query: string }).query;
        break;
      case "changeTracking": {
        const c =
          typeof f === "string"
            ? {}
            : (f as { modes?: ChangeTrackingRequest["modes"]; tag?: string | null; prompt?: string; schema?: Record<string, unknown> });
        // An empty tag is no tag, so the column the tracker keys on needs no second spelling of "none".
        out.changeTracking = { modes: [...new Set(c.modes)], tag: c.tag || null, prompt: c.prompt, schema: c.schema };
        break;
      }
      case "query": {
        const q = f as { prompt: string; mode?: "freeform" | "directQuote" };
        out.question = q.prompt;
        out.questionMode = q.mode;
        break;
      }
    }
  }
  if (out.changeTracking && !out.markdown)
    throw badRequest("The changeTracking format requires the markdown format to be specified as well");
  if (out.rawBase64 && list.length > 1) throw badRequest("The rawBase64 format cannot be combined with other formats");
  return out;
}

export function needsLlm(f: NormalizedFormats): string | undefined {
  if (f.json) return 'The "json" format';
  if (f.summary) return 'The "summary" format';
  if (f.question) return 'The "question" format';
  if (f.highlights) return 'The "highlights" format';
  return undefined;
}

/** Validates options that need a browser or LLM so jobs can fail before doing any work. */
export function assertScrapeCapabilities(ctx: ScrapeContext, options: ScrapeOptions | undefined): NormalizedFormats {
  const formats = normalizeFormats(options?.formats);
  if (options) assertSupportedOptions(ctx, options, formats);
  const unsupportedAction = options?.actions?.find((a) => a.type === "screenshot" || a.type === "pdf");
  if (unsupportedAction) throw unsupported(`The "${unsupportedAction.type}" action`);
  if (!ctx.browser?.enabled) {
    if (options?.actions?.length) throw browserRequired("Actions", ctx.missingHints?.browser);
  }
  const llmFeature = needsLlm(formats) ?? (options?.checkPromptInjection ? "checkPromptInjection" : undefined);
  if (llmFeature && !ctx.llm?.enabled) throw llmRequired(llmFeature, ctx.missingHints?.llm);
  if (formats.json?.schema) ctx.llm?.checkSchema(formats.json.schema);
  const tracking = formats.changeTracking;
  if (tracking) {
    if (!ctx.changeTracker) throw unsupported('The "changeTracking" format', ctx.missingHints?.changeTracking ?? CHANGE_TRACKING_HINT);
    if (tracking.modes.includes("json")) {
      if (!ctx.llm?.enabled) throw llmRequired('The "changeTracking" json mode', ctx.missingHints?.llm);
      if (tracking.schema) ctx.llm.checkSchema(tracking.schema);
    }
  }
  return formats;
}

/** Options that ask for something this server cannot do: refused instead of silently dropped. */
function assertSupportedOptions(ctx: ScrapeContext, options: ScrapeOptions, formats: NormalizedFormats): void {
  if (options.redactPII) throw unsupported("redactPII");
  if (options.zeroDataRetention) throw unsupported("zeroDataRetention");
  if (options.onlyCleanContent) throw unsupported("onlyCleanContent");
  // Both ask for stored data only; a live fetch would break what the caller asked for.
  if (!ctx.cache && isCacheOnly(options)) {
    throw noCachedData(`${options.lockdown ? "lockdown" : "minAge"} only reads from a cache, and this server has none.`);
  }
  if (formats.rawBase64) {
    if (options.checkPromptInjection)
      throw badRequest("checkPromptInjection scans page markdown and cannot be used with the rawBase64 format");
    if (options.actions?.length) throw badRequest("actions need a browser render and cannot be used with the rawBase64 format");
  }
  if (options.fastMode && options.actions?.length) throw badRequest("fastMode skips the browser, which actions need");
  if (startsWithStealth(ctx.config, options) && options.actions?.length) {
    throw badRequest('proxy "stealth" fetches over plain HTTP through the stealth proxy, which skips the browser that actions need');
  }
}

/** `proxy: "stealth"` on a server that has a stealth proxy: the page is fetched through it from the first request, over plain HTTP. */
const startsWithStealth = (config: Pick<CoreConfig, "stealthProxyUrl">, options: ScrapeOptions): boolean =>
  !!config.stealthProxyUrl && options.proxy === "stealth";

/** Options that are accepted but have no effect; Firecrawl's wording for a scrape that may be missing something. */
function ignoredOptionWarnings(config: Pick<CoreConfig, "stealthProxyUrl">, options: ScrapeOptions): string[] {
  const partial = "your scrape may be partial";
  const out: string[] = [];
  if (options.proxy === "enhanced" || (options.proxy === "stealth" && !config.stealthProxyUrl)) {
    out.push(`proxy "${options.proxy}" is not available; the page was fetched directly -- ${partial}`);
  }
  if (options.location?.country) out.push(`location.country is not used for geo-targeting -- ${partial}`);
  const jsonModel = options.formats?.some((f) => typeof f === "object" && f.type === "json" && "model" in f && f.model);
  if (jsonModel) out.push("The json format's model is ignored; the model is the server's SEX_LLM_MODEL");
  const unused = new Set<string>();
  for (const p of options.parsers ?? []) {
    if (typeof p === "string" || p.type !== "pdf") continue;
    for (const key of ["mode", "blocks", "refresh"] as const) {
      const v = p[key];
      if (v !== undefined && v !== false && v !== "auto") unused.add(key);
    }
  }
  if (unused.size) out.push(`The pdf parser options ${[...unused].join(", ")} are not supported and were ignored`);
  return out;
}

export interface ScrapeInternalOptions {
  /** Cancels the scrape (client disconnected, job cancelled). Ignored when `deadline` is given. */
  signal?: AbortSignal;
  /**
   * The deadline of the operation this scrape is part of (a search with `scrapeOptions`). The scrape's own `timeout` is cut
   * from it, and so is the LLM time, so the whole never outlasts it.
   */
  deadline?: Deadline;
  /** The LLM calls (the injection guard) are not bound by the scrape's `timeout`, only by `deadline` / `signal` (extract jobs). */
  llmOutsideTimeout?: boolean;
  /** Always collect links (used by crawl/map) even if the caller did not ask for them. */
  collectLinks?: boolean;
  /** The file to convert instead of fetching a URL (`scrapeUpload`); the browser is not involved. */
  upload?: { body: Uint8Array; contentType: string };
}

export interface ScrapeOutcome {
  document: Document;
  /** All links found on the page, when collectLinks was set. */
  links?: string[];
  linkTitles?: Record<string, string>;
}

export async function scrapeUrl(
  ctx: ScrapeContext,
  rawUrl: string,
  options: ScrapeOptions = {},
  internal: ScrapeInternalOptions = {},
): Promise<ScrapeOutcome> {
  const formats = assertScrapeCapabilities(ctx, options);
  const requested = parseHttpUrl(rawUrl.trim());
  // Rewritten before the SSRF check, so the URL that is actually fetched is the one that gets validated.
  const url = rewriteUrl(requested);
  await assertPublicUrl(url, ctx.config.allowPrivateNetwork);
  return ctx.scrapeLimit(() => {
    // The clock starts when the scrape does, not when it joins the queue for a free slot.
    const outer = internal.deadline ?? Deadline.unbounded(internal.signal);
    // Waiting in the queue can outlast the caller; do not start work nobody is waiting for.
    outer.throwIfAborted("before the scrape started");
    // `timeout` bounds the whole scrape: fetching or rendering, waiting, converting, extracting and the LLM calls (each
    // of which also has SEX_LLM_TIMEOUT, cut from what is left). Like Firecrawl, a request that uses the LLM (formats or the
    // injection guard) and has no `timeout` gets at least 60 s instead of the default.
    const timeout = scrapeTimeout(ctx.config, options, formats);
    const deadline = outer.slice(timeout, { expiredCode: "SCRAPE_TIMEOUT" });
    // An extract job has no time limit of its own: its guard calls are cut from the job instead.
    return scrapeInner(
      ctx,
      url.href,
      requested.href,
      options,
      formats,
      { page: deadline, llm: internal.llmOutsideTimeout ? outer : deadline },
      internal,
    );
  });
}

/** The default `timeout` of a request with LLM formats, when it is longer than SEX_TIMEOUT (Firecrawl: json 30 s -> 60 s). */
const LLM_MIN_TIMEOUT_MS = 60_000;

/** The time one scrape has: the request's `timeout`, else SEX_TIMEOUT (at least 60 s when it calls the LLM: an LLM format or the guard). */
export function scrapeTimeout(config: { timeout: number }, options: ScrapeOptions, formats: NormalizedFormats): number {
  const usesLlm = needsLlm(formats) || formats.changeTracking?.modes.includes("json") || options.checkPromptInjection;
  return options.timeout ?? (usesLlm ? Math.max(config.timeout, LLM_MIN_TIMEOUT_MS) : config.timeout);
}

/** Where the time of one scrape comes from: the same deadline, except for an extract's guard calls. */
interface ScrapeBudgets {
  /** Fetching or rendering the page, converting files, extracting content. */
  page: Deadline;
  /** What the LLM calls are cut from: each call gets `SEX_LLM_TIMEOUT` of it. */
  llm: Deadline;
}

/** A file the caller sent (`POST /v2/parse`), converted like the body of a fetched URL. Its name is the document's `sourceURL`. */
export async function scrapeUpload(
  ctx: ScrapeContext,
  file: File,
  options: ScrapeOptions = {},
  internal: ScrapeInternalOptions = {},
): Promise<ScrapeOutcome> {
  const formats = assertScrapeCapabilities(ctx, options);
  if (formats.rawBase64) throw badRequest("The rawBase64 format is not supported for uploads");
  if (formats.changeTracking) throw badRequest("The changeTracking format tracks a URL and is not supported for uploads");
  if (options.actions?.length) throw badRequest("actions need a browser render and cannot be used with an uploaded file");
  // Checked before the file is read into memory.
  if (file.size > ctx.config.maxBodyBytes) {
    throw new AppError("RESPONSE_TOO_LARGE", `The file is larger than SEX_MAX_BODY_BYTES (${ctx.config.maxBodyBytes} bytes)`);
  }
  // A synthetic URL only so the name decides the file type; it is never fetched.
  const filename = file.name || "upload";
  const url = new URL(`file:///${encodeURIComponent(filename)}`).href;
  const contentType = /^application\/octet-stream/i.test(file.type) ? "" : file.type;
  const body = new Uint8Array(await file.arrayBuffer());
  return ctx.scrapeLimit(() => {
    const outer = internal.deadline ?? Deadline.unbounded(internal.signal);
    outer.throwIfAborted("before the conversion started");
    const deadline = outer.slice(scrapeTimeout(ctx.config, options, formats), { expiredCode: "SCRAPE_TIMEOUT" });
    return scrapeInner(
      ctx,
      url,
      filename,
      options,
      formats,
      { page: deadline, llm: deadline },
      { ...internal, upload: { body, contentType } },
    );
  });
}

async function scrapeInner(
  ctx: ScrapeContext,
  url: string,
  sourceUrl: string,
  options: ScrapeOptions,
  formats: NormalizedFormats,
  { page: deadline, llm: llmDeadline }: ScrapeBudgets,
  internal: ScrapeInternalOptions,
): Promise<ScrapeOutcome> {
  const { config } = ctx;
  // The stealth proxy: `proxy: "stealth"` fetches through it from the start (so no browser, which has one fixed proxy); otherwise a
  // fetch the site blocked is retried through it once, unless the request said "basic" (or both proxies are the same).
  const stealthProxy = config.stealthProxyUrl;
  const stealthFirst = startsWithStealth(config, options);
  const stealthRetry = !!stealthProxy && !stealthFirst && options.proxy !== "basic" && stealthProxy !== config.proxyUrl;
  // fastMode: no rendering, only the HTTP fetch.
  const renderer = ctx.browser?.enabled && !options.fastMode && !stealthFirst && !internal.upload ? ctx.browser : undefined;
  const plan = cachePlan(ctx, url, options, formats, internal, !!renderer);
  if (!plan && isCacheOnly(options)) {
    throw noCachedData("lockdown and minAge only read from the cache, and this request (actions, headers, rawBase64) is never cached.");
  }
  const cached = plan?.read ? await plan.cache.get(plan.key, plan.age) : undefined;
  if (!cached && isCacheOnly(options))
    throw noCachedData("lockdown and minAge only read from the cache, and it has no such entry for this page.");
  // A cached page is answered like a fetched one, from its bytes; there is nothing for the browser to render.
  const browser = cached ? undefined : renderer;
  const docs = ctx.docs?.enabled ? ctx.docs : undefined;
  const onlyMainContent = options.onlyMainContent ?? true;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.location?.languages?.length && !Object.keys(headers).some((h) => h.toLowerCase() === "accept-language")) {
    headers["accept-language"] = options.location.languages.join(",");
  }
  const extractOpts = {
    onlyMainContent,
    includeTags: options.includeTags,
    excludeTags: options.excludeTags,
    removeBase64Images: options.removeBase64Images ?? true,
    wantLinks: formats.links || !!internal.collectLinks,
    wantLinkTitles: !!internal.collectLinks,
    wantImages: formats.images,
    attributes: formats.attributes,
  };
  const warnings: string[] = ignoredOptionWarnings(config, options);
  if (stealthFirst && ctx.browser?.enabled && !options.fastMode) {
    warnings.push('proxy "stealth": fetched over plain HTTP through the stealth proxy, so scripts did not run');
  }

  /** The last response `fetchBody` got from the network, which is what the cache stores when the plain fetch answered. */
  let fetched: FetchedResponse | undefined;
  /** The proxy of that response. */
  let fetchedVia: "basic" | "stealth" = "basic";
  const fetchBody = async (opts: { stealth?: boolean } = {}): Promise<FetchedResponse> => {
    if (internal.upload) {
      return { url, status: 200, headers: new Headers(), contentType: internal.upload.contentType, body: internal.upload.body };
    }
    if (cached)
      return { url: cached.url, status: cached.status, headers: new Headers(), contentType: cached.contentType, body: cached.body };
    const attempt = (via: "basic" | "stealth") =>
      safeFetch(url, {
        headers,
        deadline,
        allowPrivateNetwork: config.allowPrivateNetwork,
        proxy: via === "stealth" ? stealthProxy : config.proxyUrl,
        maxBodyBytes: config.maxBodyBytes,
        skipTlsVerification: options.skipTlsVerification,
        userAgent: options.mobile
          ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
          : config.userAgent,
      });
    const first = stealthFirst || opts.stealth ? "stealth" : "basic";
    let res: FetchedResponse | undefined;
    let failure: unknown;
    try {
      res = await attempt(first);
    } catch (err) {
      failure = err;
    }
    fetchedVia = first;
    // One retry, through the stealth proxy, in the time the scrape has left (the same deadline: it is cut short like any step).
    const blocked = res ? isBlocked(res.status) : failure instanceof AppError && isBlocked(failure);
    if (first === "basic" && stealthRetry && blocked && deadline.remaining() >= FALLBACK_MIN_MS) {
      const was = res ? `HTTP ${res.status}` : (failure as AppError).code;
      try {
        res = await attempt("stealth");
        failure = undefined;
        warnings.push(`The site blocked the request (${was}); retried through the stealth proxy (HTTP ${res.status}).`);
        fetchedVia = "stealth";
      } catch (err) {
        if (deadline.signal.aborted) throw deadline.translate(err);
        log.warn("retry through the stealth proxy failed", { url, error: toAppError(err).message });
        warnings.push(`The site blocked the request (${was}); the retry through the stealth proxy failed (${toAppError(err).code}).`);
      }
    }
    if (!res) throw failure;
    fetched = res;
    return res;
  };

  // The file as it is, whatever it is: never rendered, so the browser is not involved.
  if (formats.rawBase64) {
    const res = await fetchBody();
    const document: Document = {
      rawBase64: Buffer.from(res.body).toString("base64"),
      metadata: responseMetadata(sourceUrl, res.url, res.status, res.contentType, fetchedVia),
    };
    if (warnings.length) document.warning = warnings.join("; ");
    return { document };
  }

  const parsers = fileParsers(options.parsers);
  let browserResult: BrowserScrapeResult | undefined;
  /** Why the browser's answer was not used, once the page is fetched over plain HTTP instead (see `browserFallbackReason`). */
  let fallback: { reason: string } | undefined;

  // Documents and images have nothing for a browser to render, so they go straight to the HTTP fetch.
  if (browser && !fileKindOf(new URL(url)) && url === sourceUrl) {
    try {
      browserResult = await browser.scrape({
        url,
        deadline,
        headers,
        userAgent: config.userAgent,
        mobile: options.mobile,
        skipTlsVerification: options.skipTlsVerification,
        blockAds: options.blockAds ?? true,
        waitFor: options.waitFor,
        actions: options.actions,
        extract: extractOpts,
        requestGuard: config.allowPrivateNetwork
          ? undefined
          : async (u) => {
              try {
                await assertPublicUrl(new URL(u), false, !!config.proxyUrl);
                return true;
              } catch {
                return false;
              }
            },
      });
    } catch (err) {
      if (deadline.signal.aborted) throw deadline.translate(err);
      const reason = browserFallbackReason(err, options, deadline);
      if (!reason) throw err;
      fallback = { reason };
    }
  } else if (options.waitFor && !(cached && renderer)) {
    warnings.push("waitFor is ignored without a browser");
  }
  if (browser && options.waitFor && options.waitFor > scrapeTimeout(config, options, formats) / 2) {
    warnings.push("waitFor is more than half of timeout, so little time is left to load and read the page; raise timeout or lower waitFor");
  }

  /** The PDF's markdown, with page markers if asked for. Without per-page text (the converter gave none) it stays as it is. */
  const pageMarkers = (markdown: string, pages: PdfPage[] | undefined, warns: string[]) => {
    if (!parsers.pageMarkers) return markdown;
    if (!pages) {
      warns.push("pageMarkers could not be applied: the converter did not return the document page by page");
      return markdown;
    }
    return joinPages(pages, true);
  };

  const fetchPage = async (warns: string[], opts?: { stealth?: boolean }): Promise<FetchedPage> => {
    const res = await fetchBody(opts);
    const out: FetchedPage = { url: res.url, status: res.status, contentType: res.contentType, rawHtml: "", proxyUsed: fetchedVia };
    /** A converted document's `html` and `rawHtml` are its Markdown rendered; only worked out when asked for. */
    const setMarkdown = (markdown: string) => {
      out.plainMarkdown = markdown;
      if (formats.html || formats.rawHtml) out.rawHtml = markdownToHtml(markdown);
    };
    const isPdf = /application\/pdf/i.test(out.contentType) || startsWith(res.body, "%PDF-");
    if (isPdf) {
      if (!parsers.pdf) {
        // Like Firecrawl: with the parser off the file itself comes back, base64 in markdown and html.
        const base64 = Buffer.from(res.body).toString("base64");
        out.plainMarkdown = base64;
        out.rawHtml = base64;
        out.contentType = "application/pdf";
        warns.push("PDF parsing is disabled by the parsers option; markdown and html hold the file as base64");
        return out;
      }
      if (docs) {
        const doc = await convertDocument(docs, res.body, out.url, parsers.maxPages, deadline, warns);
        out.pdfPages = doc.pages;
        setMarkdown(pageMarkers(doc.markdown, doc.pages, warns));
        // `numPages` is what was converted, `totalPages` what the file has.
        const converted =
          doc.pagesConverted ?? (doc.numPages === undefined ? undefined : Math.min(doc.numPages, parsers.maxPages ?? doc.numPages));
        out.pdfMeta = { numPages: converted, totalPages: doc.numPages };
      } else {
        const pdf = await ctx.extractPool.pdf(res.body, parsers.maxPages, deadline);
        out.pdfPages = pdf.pages;
        setMarkdown(pageMarkers(pdf.markdown, pdf.pages, warns));
        out.pdfMeta = { title: pdf.title, numPages: pdf.numPages, totalPages: pdf.totalPages };
        if (pdf.numPages < pdf.totalPages) warns.push(`Extracted the first ${pdf.numPages} of ${pdf.totalPages} pages (parsers maxPages)`);
      }
      out.contentType ||= "application/pdf";
    } else if (!out.contentType && docs && isConvertibleByExtension(out.url, parsers.image)) {
      setMarkdown((await convertDocument(docs, res.body, out.url, undefined, deadline, warns)).markdown);
    } else if (docs && /^text\/csv/i.test(out.contentType)) {
      // The URL need not say it is CSV (a Google Sheets export does not), so the content type becomes the file name.
      setMarkdown((await convertDocument(docs, res.body, out.url, undefined, deadline, warns, "data.csv")).markdown);
    } else if (!out.contentType || MARKUP_TYPE.test(out.contentType)) {
      out.rawHtml = decodeBody(res.body, out.contentType);
      out.extracted = await ctx.extractPool.html(out.rawHtml, { ...extractOpts, url: out.url }, deadline);
    } else if (/^(text\/|application\/(json|javascript|x-ndjson))/i.test(out.contentType)) {
      const text = decodeBody(res.body, out.contentType);
      out.plainMarkdown = /json/i.test(out.contentType) ? `\`\`\`json\n${text}\n\`\`\`` : text;
      out.rawHtml = text;
    } else if (docs && (parsers.image || !/^image\//i.test(out.contentType))) {
      // Office documents, EPUB, RTF and (with the "image" parser) raster images; here-docs detects the format from the bytes.
      setMarkdown((await convertDocument(docs, res.body, out.url, undefined, deadline, warns)).markdown);
    } else {
      throw new AppError("UNSUPPORTED_FILE", `Unsupported content type: ${out.contentType}`);
    }
    return out;
  };

  let page: FetchedPage | undefined;
  /** What goes into the cache: the browser's rendered HTML, or the plain fetch's response. Never a fallback's or an empty page. */
  let storable: CachedPage | undefined;
  if (fallback) {
    // The browser could not answer; the plain fetch is the last try, so its error is the one reported.
    page = await fetchPage(warnings);
    warnings.push(`Browser failed (${fallback.reason}); fell back to HTTP fetch, so scripts did not run.`);
  } else if (!browserResult || browserResult.nonHtml) {
    page = await fetchPage(warnings);
    if (fetched) storable = { url: fetched.url, status: fetched.status, contentType: fetched.contentType, body: fetched.body };
  } else if (emptyBrowserPage(browserResult, options, deadline)) {
    // A 2xx page without content is usually one whose content needs the HTML the browser did not wait for or was blocked from;
    // the browser's answer stays unless the plain fetch finds something.
    const warns: string[] = [];
    const tried = await fetchPage(warns).catch((err: unknown) => {
      if (deadline.signal.aborted) throw deadline.translate(err);
      log.warn("HTTP fetch after an empty browser page failed", { url, error: toAppError(err).message });
      return undefined;
    });
    if (tried?.extracted?.markdown.trim() && tried.status >= 200 && tried.status < 300) {
      page = tried;
      warnings.push(...warns, "Browser returned no content; fell back to HTTP fetch, so scripts did not run.");
    } else {
      warnings.push("Browser returned no content, and an HTTP fetch found none either.");
    }
  } else if (stealthRetry && isBlocked(browserResult.status) && !options.actions?.length && deadline.remaining() >= FALLBACK_MIN_MS) {
    // The browser has the one proxy it was started with; the stealth proxy can only be used by a plain fetch, which replaces
    // the browser's page only if it is not blocked too.
    const warns: string[] = [];
    const tried = await fetchPage(warns, { stealth: true }).catch((err: unknown) => {
      if (deadline.signal.aborted) throw deadline.translate(err);
      log.warn("HTTP fetch through the stealth proxy after a blocked browser page failed", { url, error: toAppError(err).message });
      return undefined;
    });
    const blockedBy = `The browser was blocked by the site (HTTP ${browserResult.status})`;
    if (tried && !isBlocked(tried.status)) {
      page = tried;
      warnings.push(
        ...warns,
        `${blockedBy}; fetched over plain HTTP through the stealth proxy instead (HTTP ${tried.status}), so scripts did not run.`,
      );
    } else {
      warnings.push(
        `${blockedBy}; a plain HTTP fetch through the stealth proxy ${tried ? `was blocked too (HTTP ${tried.status})` : "failed"}.`,
      );
    }
  } else {
    const type = browserResult.contentType.split(";")[0]?.trim() || "text/html";
    storable = {
      url: browserResult.url,
      status: browserResult.status,
      contentType: `${type}; charset=utf-8`,
      body: new TextEncoder().encode(browserResult.rawHtml),
    };
  }
  if (plan?.write && storable && storable.status >= 200 && storable.status < 300) await plan.cache.put(plan.key, storable);
  const {
    url: finalUrl,
    status,
    contentType,
    rawHtml,
    extracted,
    plainMarkdown,
    pdfPages,
    pdfMeta,
  } = page ?? {
    ...(browserResult as BrowserScrapeResult),
    plainMarkdown: undefined,
    pdfPages: undefined,
    pdfMeta: undefined,
  };

  if (extracted?.notes.length) warnings.push(...extracted.notes);
  let markdown = plainMarkdown ?? extracted?.markdown ?? "";
  const metadata: Record<string, unknown> = { ...(extracted?.metadata ?? {}) };
  // Repeated <meta> tags can yield arrays (page-script `add`); the schema types these keys as strings.
  // Coerce before deriving `title` so a page without <title> does not get a comma-joined array.
  for (const k of ["title", "description", "language", "error"]) {
    const v = metadata[k];
    if (!Array.isArray(v)) continue;
    const first = v.find((x): x is string => typeof x === "string" && x.length > 0);
    if (first === undefined) delete metadata[k];
    else metadata[k] = first;
  }
  const title = String(metadata.title ?? "") || extracted?.defuddle.title || pdfMeta?.title || "";
  if (extracted && onlyMainContent && !options.includeTags?.length) {
    const heading = extracted.defuddle.title || title;
    if (heading && !/^#\s/.test(markdown.trimStart())) markdown = `# ${heading}\n\n${markdown}`;
  }

  if (title) metadata.title = title;
  const d = extracted?.defuddle;
  if (d) {
    if (!metadata.description && d.description) metadata.description = d.description;
    if (!metadata.language && d.language) metadata.language = d.language;
    if (d.author) metadata.author = d.author;
    if (!metadata.publishedTime && d.published) metadata.publishedTime = d.published;
    if (!metadata.ogSiteName && d.site) metadata.ogSiteName = d.site;
    if (!metadata.ogImage && d.image) metadata.ogImage = d.image;
    if (d.wordCount) metadata.wordCount = d.wordCount;
  }
  if (pdfMeta?.numPages) metadata.numPages = pdfMeta.numPages;
  if (pdfMeta?.totalPages) metadata.totalPages = pdfMeta.totalPages;
  Object.assign(metadata, responseMetadata(sourceUrl, finalUrl, status, contentType, page?.proxyUsed ?? "basic", cached?.storedAt));
  // Without a browser (none configured, fastMode, or it failed) only the User-Agent says "mobile". (A cached page keeps
  // the answer it was stored with; a rendered one is not told apart from a fetched one here, so it gets no warning.)
  if (options.mobile && (page || !browserResult) && !(cached && renderer)) {
    warnings.push("mobile only changes the User-Agent without a browser, and no mobile viewport is used -- your scrape may be partial");
  }

  const doc: Document = { metadata };
  if (formats.markdown) doc.markdown = markdown;
  if (parsers.pages && pdfPages) doc.pages = pdfPages;
  else if (parsers.pages && pdfMeta) warnings.push("pages could not be returned: the converter did not return the document page by page");
  if (formats.html) doc.html = extracted?.html ?? rawHtml;
  if (formats.rawHtml) doc.rawHtml = rawHtml;
  if (formats.links) doc.links = extracted?.links ?? [];
  if (formats.images) doc.images = extracted?.images ?? [];
  if (formats.attributes) doc.attributes = extracted?.attributes ?? [];
  if (browserResult?.actions) doc.actions = browserResult.actions;

  // What the LLM gets: the title and the page. With the guard on, it scans exactly this text, so nothing unscanned is sent.
  const heading = title ? `# ${title}\n\n` : "";
  let body = markdown;
  // assertScrapeCapabilities has refused the guard and the LLM formats without an enabled LLM.
  const llm = ctx.llm as ScrapeLlm;
  if (options.checkPromptInjection) {
    // Runs before every LLM-backed format, so content it blocks never reaches one.
    if (body.length > GUARD_MAX_CHARS) {
      body = body.slice(0, GUARD_MAX_CHARS);
      warnings.push(
        `The prompt injection check scanned only the first ${GUARD_MAX_CHARS} characters of the page; the rest is not sent to the LLM.`,
      );
    }
    const { scannedFully } = await llm.checkInjection(`${heading}${body}`, llmDeadline);
    if (!scannedFully) warnings.push("The prompt injection check could not scan all of the page content, so some of it was not checked.");
  }

  if (needsLlm(formats)) {
    const { text: content, truncated } = llm.fit(`${heading}${body}`);
    if (truncated) warnings.push(`The page was too long for the LLM; only its first ${llm.maxInputChars} characters were used.`);
    const settled = await Promise.allSettled([
      formats.json ? llm.extractJson(content, { ...formats.json, url: finalUrl }, llmDeadline) : undefined,
      formats.summary ? llm.summarize(content, llmDeadline, finalUrl) : undefined,
      formats.question
        ? formats.questionMode === "directQuote"
          ? llm.selectLines(content, formats.question, "answer", llmDeadline, finalUrl)
          : llm.answer(content, formats.question, llmDeadline, finalUrl)
        : undefined,
      formats.highlights ? llm.selectLines(content, formats.highlights, "highlights", llmDeadline, finalUrl) : undefined,
    ]);
    // A failed format must not throw away the rest of the page; only configuration, injection and the end of the deadline do.
    const labels = ["JSON extraction", "Summary", "Question answering", "Highlights"];
    const values: unknown[] = settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const err = toAppError(r.reason);
      if (llmDeadline.signal.aborted) throw llmDeadline.translate(r.reason);
      if (err.status === 501 || err.code === "SCRAPE_PROMPT_INJECTION_DETECTED") throw r.reason;
      log.warn("LLM format failed", { format: labels[i], code: err.code, error: err.message });
      warnings.push(`${labels[i]} failed: ${err.message}`);
      return undefined;
    });
    if (formats.json) doc.json = (values[0] as typeof doc.json | undefined) ?? null;
    if (values[1] !== undefined) doc.summary = values[1] as string;
    if (values[2] !== undefined) doc.answer = values[2] as typeof doc.answer;
    if (values[3] !== undefined) doc.highlights = values[3] as typeof doc.highlights;
  }

  if (formats.changeTracking) {
    // assertScrapeCapabilities has refused the format without a tracker; the markdown format is required, so `markdown` is what the caller sees.
    const changes = await trackChanges({
      tracker: ctx.changeTracker as ChangeTracker,
      llm,
      request: formats.changeTracking,
      url: sourceUrl,
      markdown,
      scanned: body,
      guard: !!options.checkPromptInjection,
      status,
      deadline: llmDeadline,
      warnings,
    });
    if (changes) doc.changeTracking = changes;
  }
  if (warnings.length) doc.warning = warnings.join("; ");

  // The page script keeps mailto: links for the `links` format; crawl and map only follow http(s).
  const links = extracted?.links?.filter((l) => /^https?:/i.test(l));
  return { document: doc, links, linkTitles: extracted?.linkTitles };
}

/** The metadata every document has, whatever produced it. */
function responseMetadata(
  sourceUrl: string,
  finalUrl: string,
  status: number,
  contentType: string,
  proxyUsed: "basic" | "stealth",
  cachedAt?: number,
) {
  return {
    sourceURL: sourceUrl,
    url: finalUrl,
    statusCode: status,
    contentType: contentType.split(";")[0]?.trim() || undefined,
    scrapeId: randomUUID(),
    proxyUsed,
    cacheState: cachedAt === undefined ? "miss" : "hit",
    cachedAt: cachedAt === undefined ? undefined : new Date(cachedAt).toISOString(),
  };
}

const isCacheOnly = (options: ScrapeOptions) => !!options.lockdown || options.minAge !== undefined;

const noCachedData = (why: string) => new AppError("SCRAPE_NO_CACHED_DATA", `No cached data is available: ${why}`);

/** What the cache is asked and told for one scrape. */
interface CachePlan {
  cache: ScrapeCache;
  key: CacheKey;
  age: { minAge?: number; maxAge: number };
  /** Look the page up; false for `maxAge: 0`, which fetches fresh and replaces the entry. */
  read: boolean;
  /** Store what the scrape fetched. */
  write: boolean;
}

/**
 * Whether and how this scrape uses the cache; undefined when it must not: no cache, uploads, `rawBase64` (the original bytes of
 * a rendered page do not exist), actions (they change the page), custom headers (they may be a login), and a request with no
 * `maxAge` of its own on a server whose default is 0.
 * `maxAge: 0` (like Firecrawl) does not read, but stores, so it refreshes the entry; `storeInCache: false` stops that.
 * `lockdown` / `minAge` read only and take any entry up to `retention` old when `maxAge` is not given.
 *
 * The key holds what changes the stored bytes: the fetched URL, whether the browser rendered it (and `waitFor`, `blockAds`),
 * `mobile`, `skipTlsVerification` and the languages (an `Accept-Language` header). The formats, selectors, `parsers` and LLM
 * options act on the stored bytes afterwards, so they are not in it and one entry serves every request for the page.
 */
function cachePlan(
  ctx: ScrapeContext,
  url: string,
  options: ScrapeOptions,
  formats: NormalizedFormats,
  internal: ScrapeInternalOptions,
  rendered: boolean,
): CachePlan | undefined {
  const { cache } = ctx;
  if (!cache || internal.upload || formats.rawBase64 || options.actions?.length || Object.keys(options.headers ?? {}).length)
    return undefined;
  const cacheOnly = isCacheOnly(options);
  const maxAge = Math.min(Math.max(options.maxAge ?? (cacheOnly ? cache.retention : cache.defaultMaxAge), 0), cache.retention);
  if (!cacheOnly && options.maxAge === undefined && cache.defaultMaxAge === 0) return undefined;
  const target = new URL(url);
  target.hash = "";
  const variant = [
    rendered ? "browser" : "http",
    rendered && options.blockAds === false ? "ads" : "",
    rendered && options.waitFor ? `wait=${options.waitFor}` : "",
    options.mobile ? "mobile" : "",
    options.skipTlsVerification ? "insecure" : "",
    options.location?.languages?.length ? `lang=${options.location.languages.join(",")}` : "",
  ]
    .filter(Boolean)
    .join(";");
  return {
    cache,
    key: { url: target.href, variant },
    age: { minAge: options.minAge, maxAge },
    read: cacheOnly || maxAge > 0,
    write: !cacheOnly && options.storeInCache !== false,
  };
}

/** What a plain HTTP fetch of the page yielded. */
interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  rawHtml: string;
  /** The proxy the response came through (`metadata.proxyUsed`). */
  proxyUsed: "basic" | "stealth";
  extracted?: PageExtractResult;
  plainMarkdown?: string;
  /** The PDF page by page, when the converter could tell. */
  pdfPages?: PdfPage[];
  /** `numPages`: pages extracted; `totalPages`: pages in the file. */
  pdfMeta?: { title?: string; numPages?: number; totalPages?: number };
}

/** The least time a fallback HTTP fetch is started with; with less left the browser's own answer (or error) stands. */
const FALLBACK_MIN_MS = 2_000;

/**
 * Whether a failed browser scrape may be answered by fetching the page over plain HTTP, and why. Which errors qualify is
 * `ERRORS[code].fallback` alone; this adds what the catalog cannot know: a request with actions needs the browser, and
 * the fetch must fit in the time the scrape has left. Returns undefined when the error should be thrown as it is.
 */
function browserFallbackReason(err: unknown, options: ScrapeOptions, deadline: Deadline): string | undefined {
  if (!(err instanceof AppError) || !err.fallback) return undefined;
  if (options.actions?.length || deadline.remaining() < FALLBACK_MIN_MS) return undefined;
  return `${err.code}: ${err.message}`;
}

/** A 2xx page the browser rendered, whose content came out empty, and a fetch would still fit in the time left. */
function emptyBrowserPage(result: BrowserScrapeResult, options: ScrapeOptions, deadline: Deadline): boolean {
  return (
    !!result.extracted &&
    result.extracted.markdown.trim() === "" &&
    result.status >= 200 &&
    result.status < 300 &&
    !options.actions?.length &&
    deadline.remaining() >= FALLBACK_MIN_MS
  );
}

interface FileParsers {
  pdf: boolean;
  image: boolean;
  maxPages?: number;
  /** Return `Document.pages`. */
  pages: boolean;
  /** Mark the page boundaries in the markdown. */
  pageMarkers: boolean;
}

/** Firecrawl `parsers`: which file parsers may run, and the PDF page budget. Omitted means every parser, all pages. */
function fileParsers(parsers: ScrapeOptions["parsers"]): FileParsers {
  if (parsers === undefined) return { pdf: true, image: true, pages: false, pageMarkers: false };
  const out: FileParsers = { pdf: false, image: false, pages: false, pageMarkers: false };
  for (const p of parsers) {
    if (p === "image" || (typeof p === "object" && p.type === "image")) out.image = true;
    if (p === "pdf") out.pdf = true;
    if (typeof p === "object" && p.type === "pdf") {
      out.pdf = true;
      if (p.maxPages !== undefined) out.maxPages = p.maxPages;
      out.pages ||= (p.pages ?? p.pageMarkdown) === true;
      out.pageMarkers ||= p.pageMarkers === true;
    }
  }
  return out;
}

async function convertDocument(
  docs: ScrapeDocs,
  body: Uint8Array,
  url: string,
  maxPages: number | undefined,
  deadline: Deadline,
  warnings: string[],
  filenameHint?: string,
) {
  const filename = filenameHint ?? (decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || undefined);
  const doc = await docs.convert(body, { filename, maxPages, deadline });
  for (const w of doc.warnings) warnings.push(w.message);
  // Only when `maxPages` was what stopped the conversion; a timeout's partial result carries its own warning.
  if (maxPages !== undefined && doc.numPages !== undefined && doc.pagesConverted === maxPages && doc.pagesConverted < doc.numPages) {
    warnings.push(`Converted the first ${doc.pagesConverted} of ${doc.numPages} pages (parsers maxPages)`);
  }
  return doc;
}

/** A response without a content-type is HTML unless the URL names a file here-docs can convert. */
function isConvertibleByExtension(url: string, images: boolean): boolean {
  const kind = fileKindOf(new URL(url));
  return kind === "document" || (kind === "image" && images);
}

function startsWith(body: Uint8Array, prefix: string): boolean {
  if (body.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (body[i] !== prefix.charCodeAt(i)) return false;
  return true;
}
