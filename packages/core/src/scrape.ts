import { randomUUID } from "node:crypto";
import type { LimitFunction } from "p-limit";
import { type BrowserScrapeResult, GUARD_MAX_CHARS, type ScrapeBrowser, type ScrapeDocs, type ScrapeLlm } from "./capabilities.ts";
import type { CoreConfig } from "./config.ts";
import { Deadline } from "./deadline.ts";
import { AppError, browserRequired, llmRequired, toAppError, unsupported } from "./errors.ts";
import type { ExtractPool } from "./extract-pool.ts";
import { log } from "./log.ts";
import { assertPublicUrl, decodeBody, MARKUP_TYPE, parseHttpUrl, safeFetch } from "./net.ts";
import type { PageExtractResult } from "./page.ts";
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
  /** How to get a missing browser or LLM, for the 501 errors; defaults to sex's flags. */
  readonly missingHints?: MissingHints;
}

export interface MissingHints {
  browser?: string;
  llm?: string;
}

export interface NormalizedFormats {
  markdown: boolean;
  html: boolean;
  rawHtml: boolean;
  links: boolean;
  images: boolean;
  summary: boolean;
  json?: { prompt?: string; schema?: Record<string, unknown> };
  attributes?: Array<{ selector: string; attribute: string }>;
  question?: string;
  /** `query` format mode: "directQuote" answers with verbatim page lines. */
  questionMode?: "freeform" | "directQuote";
  highlights?: string;
}

const UNSUPPORTED_FORMATS = new Set([
  "screenshot",
  "screenshot@fullPage",
  "changeTracking",
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
    links: false,
    images: false,
    summary: false,
  };
  for (const f of formats?.length ? formats : ["markdown" as const]) {
    const type = typeof f === "string" ? f : f.type;
    if (UNSUPPORTED_FORMATS.has(type)) throw unsupported(`The "${type}" format`);
    switch (type) {
      case "markdown":
      case "html":
      case "rawHtml":
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
      case "query": {
        const q = f as { prompt: string; mode?: "freeform" | "directQuote" };
        out.question = q.prompt;
        out.questionMode = q.mode;
        break;
      }
    }
  }
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
  const unsupportedAction = options?.actions?.find((a) => a.type === "screenshot" || a.type === "pdf");
  if (unsupportedAction) throw unsupported(`The "${unsupportedAction.type}" action`);
  if (!ctx.browser?.enabled) {
    if (options?.actions?.length) throw browserRequired("Actions", ctx.missingHints?.browser);
  }
  const llmFeature = needsLlm(formats) ?? (options?.checkPromptInjection ? "checkPromptInjection" : undefined);
  if (llmFeature && !ctx.llm?.enabled) throw llmRequired(llmFeature, ctx.missingHints?.llm);
  if (formats.json?.schema) ctx.llm?.checkSchema(formats.json.schema);
  return formats;
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
  const usesLlm = needsLlm(formats) || options.checkPromptInjection;
  return options.timeout ?? (usesLlm ? Math.max(config.timeout, LLM_MIN_TIMEOUT_MS) : config.timeout);
}

/** Where the time of one scrape comes from: the same deadline, except for an extract's guard calls. */
interface ScrapeBudgets {
  /** Fetching or rendering the page, converting files, extracting content. */
  page: Deadline;
  /** What the LLM calls are cut from: each call gets `SEX_LLM_TIMEOUT` of it. */
  llm: Deadline;
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
  const browser = ctx.browser?.enabled ? ctx.browser : undefined;
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
  const warnings: string[] = [];

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
                await assertPublicUrl(new URL(u), false);
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
  } else if (options.waitFor) {
    warnings.push("waitFor is ignored without a browser");
  }
  if (browser && options.waitFor && options.waitFor > scrapeTimeout(config, options, formats) / 2) {
    warnings.push("waitFor is more than half of timeout, so little time is left to load and read the page; raise timeout or lower waitFor");
  }

  const fetchPage = async (warns: string[]): Promise<FetchedPage> => {
    const res = await safeFetch(url, {
      headers,
      deadline,
      allowPrivateNetwork: config.allowPrivateNetwork,
      maxBodyBytes: config.maxBodyBytes,
      skipTlsVerification: options.skipTlsVerification,
      userAgent: options.mobile
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        : config.userAgent,
    });
    const out: FetchedPage = { url: res.url, status: res.status, contentType: res.contentType, rawHtml: "" };
    const isPdf = /application\/pdf/i.test(out.contentType) || startsWith(res.body, "%PDF-");
    if (isPdf) {
      if (!parsers.pdf) throw new AppError("UNSUPPORTED_FILE", "PDF parsing is disabled by the parsers option");
      if (docs) {
        const doc = await convertDocument(docs, res.body, out.url, parsers.maxPages, deadline, warns);
        out.plainMarkdown = doc.markdown;
        out.pdfMeta = { numPages: doc.numPages };
      } else {
        const pdf = await ctx.extractPool.pdf(res.body, parsers.maxPages, deadline);
        out.plainMarkdown = pdf.markdown;
        out.pdfMeta = { title: pdf.title, numPages: pdf.numPages };
      }
      out.contentType ||= "application/pdf";
    } else if (!out.contentType && docs && isConvertibleByExtension(out.url, parsers.image)) {
      out.plainMarkdown = (await convertDocument(docs, res.body, out.url, undefined, deadline, warns)).markdown;
    } else if (!out.contentType || MARKUP_TYPE.test(out.contentType)) {
      out.rawHtml = decodeBody(res.body, out.contentType);
      out.extracted = await ctx.extractPool.html(out.rawHtml, { ...extractOpts, url: out.url }, deadline);
    } else if (/^(text\/|application\/(json|javascript|x-ndjson))/i.test(out.contentType)) {
      const text = decodeBody(res.body, out.contentType);
      out.plainMarkdown = /json/i.test(out.contentType) ? `\`\`\`json\n${text}\n\`\`\`` : text;
      out.rawHtml = text;
    } else if (docs && (parsers.image || !/^image\//i.test(out.contentType))) {
      // Office documents, EPUB, RTF and (with the "image" parser) raster images; here-docs detects the format from the bytes.
      out.plainMarkdown = (await convertDocument(docs, res.body, out.url, undefined, deadline, warns)).markdown;
    } else {
      throw new AppError("UNSUPPORTED_FILE", `Unsupported content type: ${out.contentType}`);
    }
    return out;
  };

  let page: FetchedPage | undefined;
  if (fallback) {
    // The browser could not answer; the plain fetch is the last try, so its error is the one reported.
    page = await fetchPage(warnings);
    warnings.push(`Browser failed (${fallback.reason}); fell back to HTTP fetch, so scripts did not run.`);
  } else if (!browserResult || browserResult.nonHtml) {
    page = await fetchPage(warnings);
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
  }
  const { url: finalUrl, status, contentType, rawHtml, extracted, plainMarkdown, pdfMeta } = page ?? {
    ...(browserResult as BrowserScrapeResult),
    plainMarkdown: undefined,
    pdfMeta: undefined,
  };

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
  Object.assign(metadata, {
    sourceURL: sourceUrl,
    url: finalUrl,
    statusCode: status,
    contentType: contentType.split(";")[0]?.trim() || undefined,
    scrapeId: randomUUID(),
    proxyUsed: "basic",
    cacheState: "miss",
  });

  const doc: Document = { metadata };
  if (formats.markdown) doc.markdown = markdown;
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
  if (warnings.length) doc.warning = warnings.join("; ");

  // The page script keeps mailto: links for the `links` format; crawl and map only follow http(s).
  const links = extracted?.links?.filter((l) => /^https?:/i.test(l));
  return { document: doc, links, linkTitles: extracted?.linkTitles };
}

/** What a plain HTTP fetch of the page yielded. */
interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  rawHtml: string;
  extracted?: PageExtractResult;
  plainMarkdown?: string;
  pdfMeta?: { title?: string; numPages?: number };
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

/** Firecrawl `parsers`: which file parsers may run, and the PDF page budget. Omitted means every parser, all pages. */
function fileParsers(parsers: ScrapeOptions["parsers"]): { pdf: boolean; image: boolean; maxPages?: number } {
  if (parsers === undefined) return { pdf: true, image: true };
  const out: { pdf: boolean; image: boolean; maxPages?: number } = { pdf: false, image: false };
  for (const p of parsers) {
    const type = typeof p === "string" ? p : p.type;
    if (type === "image") out.image = true;
    if (type !== "pdf") continue;
    out.pdf = true;
    if (typeof p !== "string" && p.maxPages !== undefined) out.maxPages = p.maxPages;
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
) {
  const filename = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || undefined;
  const doc = await docs.convert(body, { filename, maxPages, deadline });
  for (const w of doc.warnings) warnings.push(w.message);
  if (doc.numPages !== undefined && doc.pagesConverted !== undefined && doc.pagesConverted < doc.numPages) {
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
