import { randomUUID } from "node:crypto";
import { AppError, browserRequired, llmRequired, toAppError, unsupported } from "../errors.ts";
import { log } from "../log.ts";
import type { Document, FormatOption, ScrapeOptions } from "../schemas.ts";
import type { BrowserScrapeResult } from "./browser.ts";
import { Deadline } from "./deadline.ts";
import type { Engine } from "./engine.ts";
import { compileJsonSchema } from "./json-schema.ts";
import { assertPublicUrl, decodeBody, MARKUP_TYPE, parseHttpUrl, safeFetch } from "./net.ts";
import type { PageExtractResult } from "./page.ts";
import { fileKindOf, rewriteUrl } from "./rewrite.ts";

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
export function assertScrapeCapabilities(engine: Engine, options: ScrapeOptions | undefined): NormalizedFormats {
  const formats = normalizeFormats(options?.formats);
  const unsupportedAction = options?.actions?.find((a) => a.type === "screenshot" || a.type === "pdf");
  if (unsupportedAction) throw unsupported(`The "${unsupportedAction.type}" action`);
  if (!engine.browser.enabled) {
    if (options?.actions?.length) throw browserRequired("Actions");
  }
  const llmFeature = needsLlm(formats) ?? (options?.checkPromptInjection ? "checkPromptInjection" : undefined);
  if (llmFeature && !engine.llm.enabled) throw llmRequired(llmFeature);
  if (formats.json?.schema) compileJsonSchema(formats.json.schema);
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
  engine: Engine,
  rawUrl: string,
  options: ScrapeOptions = {},
  internal: ScrapeInternalOptions = {},
): Promise<ScrapeOutcome> {
  const formats = assertScrapeCapabilities(engine, options);
  const requested = parseHttpUrl(rawUrl.trim());
  // Rewritten before the SSRF check, so the URL that is actually fetched is the one that gets validated.
  const url = rewriteUrl(requested);
  await assertPublicUrl(url, engine.config.allowPrivateNetwork);
  return engine.scrapeLimit(() => {
    // The clock starts when the scrape does, not when it joins the queue for a free slot.
    const outer = internal.deadline ?? Deadline.unbounded(internal.signal);
    // Waiting in the queue can outlast the caller; do not start work nobody is waiting for.
    outer.throwIfAborted("before the scrape started");
    // `timeout` bounds getting the document: fetching or rendering, waiting, converting and extracting. The LLM formats
    // are not part of it (Firecrawl counts them): they have SEX_LLM_TIMEOUT, 120 s by default against a 30 s timeout.
    const budgets = { page: outer.slice(options.timeout ?? engine.config.timeout, { expiredCode: "SCRAPE_TIMEOUT" }), llm: outer };
    return scrapeInner(engine, url.href, requested.href, options, formats, budgets, internal);
  });
}

/** Where the time of one scrape comes from. */
interface ScrapeBudgets {
  /** Fetching or rendering the page, converting files, extracting content. */
  page: Deadline;
  /** What the LLM calls are cut from: each call gets `SEX_LLM_TIMEOUT` of it. */
  llm: Deadline;
}

async function scrapeInner(
  engine: Engine,
  url: string,
  sourceUrl: string,
  options: ScrapeOptions,
  formats: NormalizedFormats,
  { page: deadline, llm: llmDeadline }: ScrapeBudgets,
  internal: ScrapeInternalOptions,
): Promise<ScrapeOutcome> {
  const { config } = engine;
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

  let finalUrl = url;
  let status = 200;
  let contentType = "";
  let rawHtml = "";
  let extracted: PageExtractResult | undefined;
  let plainMarkdown: string | undefined;
  let pdfMeta: { title?: string; numPages?: number } | undefined;
  const parsers = fileParsers(options.parsers);
  let browserResult: BrowserScrapeResult | undefined;

  // Documents and images have nothing for a browser to render, so they go straight to the HTTP fetch.
  if (engine.browser.enabled && !fileKindOf(new URL(url)) && url === sourceUrl) {
    browserResult = await engine.browser.scrape({
      url,
      deadline,
      headers,
      userAgent: config.userAgent,
      mobile: options.mobile,
      skipTlsVerification: options.skipTlsVerification,
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
    ({ url: finalUrl, status, contentType } = browserResult);
    rawHtml = browserResult.rawHtml;
    extracted = browserResult.extracted;
  } else if (options.waitFor) {
    warnings.push("waitFor is ignored without a browser");
  }
  if (engine.browser.enabled && options.waitFor && options.waitFor > (options.timeout ?? config.timeout) / 2) {
    warnings.push("waitFor is more than half of timeout, so little time is left to load and read the page; raise timeout or lower waitFor");
  }

  if (!browserResult || browserResult.nonHtml) {
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
    finalUrl = res.url;
    status = res.status;
    contentType = res.contentType;
    const isPdf = /application\/pdf/i.test(contentType) || startsWith(res.body, "%PDF-");
    if (isPdf) {
      if (!parsers.pdf) throw new AppError("UNSUPPORTED_FILE", "PDF parsing is disabled by the parsers option");
      if (engine.docs.enabled) {
        const doc = await convertDocument(engine, res.body, finalUrl, parsers.maxPages, deadline, warnings);
        plainMarkdown = doc.markdown;
        pdfMeta = { numPages: doc.numPages };
      } else {
        const pdf = await engine.extractPool.pdf(res.body, parsers.maxPages, deadline);
        plainMarkdown = pdf.markdown;
        pdfMeta = { title: pdf.title, numPages: pdf.numPages };
      }
      contentType ||= "application/pdf";
    } else if (!contentType && engine.docs.enabled && isConvertibleByExtension(finalUrl, parsers.image)) {
      plainMarkdown = (await convertDocument(engine, res.body, finalUrl, undefined, deadline, warnings)).markdown;
    } else if (!contentType || MARKUP_TYPE.test(contentType)) {
      rawHtml = decodeBody(res.body, contentType);
      extracted = await engine.extractPool.html(rawHtml, { ...extractOpts, url: finalUrl }, deadline);
    } else if (/^(text\/|application\/(json|javascript|x-ndjson))/i.test(contentType)) {
      const text = decodeBody(res.body, contentType);
      plainMarkdown = /json/i.test(contentType) ? `\`\`\`json\n${text}\n\`\`\`` : text;
      rawHtml = text;
    } else if (engine.docs.enabled && (parsers.image || !/^image\//i.test(contentType))) {
      // Office documents, EPUB, RTF and (with the "image" parser) raster images; here-docs detects the format from the bytes.
      plainMarkdown = (await convertDocument(engine, res.body, finalUrl, undefined, deadline, warnings)).markdown;
    } else {
      throw new AppError("UNSUPPORTED_FILE", `Unsupported content type: ${contentType}`);
    }
  }

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

  if (options.checkPromptInjection) {
    // Runs before every LLM-backed format, so content it blocks never reaches one.
    const { text, truncated } = engine.llm.fit(markdown);
    const { scannedFully } = await engine.llm.checkInjection(text, llmDeadline);
    if (truncated || !scannedFully) {
      warnings.push(
        truncated
          ? `The prompt injection check scanned only the first ${engine.llm.maxInputChars} characters of the page.`
          : "The prompt injection check could not scan all of the page content, so some of it was not checked.",
      );
    }
  }

  if (needsLlm(formats)) {
    const { text: content, truncated } = engine.llm.fit(`${title ? `# ${title}\n\n` : ""}${markdown}`);
    if (truncated) warnings.push(`The page was too long for the LLM; only its first ${engine.llm.maxInputChars} characters were used.`);
    const { llm } = engine;
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
  engine: Engine,
  body: Uint8Array,
  url: string,
  maxPages: number | undefined,
  deadline: Deadline,
  warnings: string[],
) {
  const filename = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || undefined;
  const doc = await engine.docs.convert(body, { filename, maxPages, deadline });
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
