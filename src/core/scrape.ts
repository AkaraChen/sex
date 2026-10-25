import { randomUUID } from "node:crypto";
import { AppError, browserRequired, llmRequired, unsupported } from "../errors.ts";
import type { Document, FormatOption, ScrapeOptions } from "../schemas.ts";
import type { BrowserScrapeResult } from "./browser.ts";
import type { Engine } from "./engine.ts";
import { assertPublicUrl, decodeBody, parseHttpUrl, safeFetch } from "./net.ts";
import { extractFromHtml, type PageExtractResult } from "./page.ts";
import { pdfToMarkdown } from "./pdf.ts";

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
      case "query":
        out.question = (f as { prompt: string }).prompt;
        break;
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
  const llmFeature = needsLlm(formats);
  if (llmFeature && !engine.llm.enabled) throw llmRequired(llmFeature);
  return formats;
}

export interface ScrapeInternalOptions {
  signal?: AbortSignal;
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
  const url = parseHttpUrl(rawUrl.trim());
  await assertPublicUrl(url, engine.config.allowPrivateNetwork);
  return engine.scrapeLimit(() => scrapeInner(engine, url.href, options, formats, internal));
}

async function scrapeInner(
  engine: Engine,
  url: string,
  options: ScrapeOptions,
  formats: NormalizedFormats,
  internal: ScrapeInternalOptions,
): Promise<ScrapeOutcome> {
  const { config } = engine;
  const timeout = options.timeout ?? config.timeout;
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
  let browserResult: BrowserScrapeResult | undefined;

  if (engine.browser.enabled) {
    browserResult = await engine.browser.scrape({
      url,
      timeout,
      headers,
      userAgent: config.userAgent,
      mobile: options.mobile,
      waitFor: options.waitFor,
      actions: options.actions,
      extract: extractOpts,
    });
    ({ url: finalUrl, status, contentType } = browserResult);
    rawHtml = browserResult.rawHtml;
    extracted = browserResult.extracted;
  } else if (options.waitFor) {
    warnings.push("waitFor is ignored without a browser");
  }

  if (!browserResult || browserResult.nonHtml) {
    const res = await safeFetch(url, {
      headers,
      timeout,
      signal: internal.signal,
      allowPrivateNetwork: config.allowPrivateNetwork,
      skipTlsVerification: options.skipTlsVerification,
      userAgent: options.mobile
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        : config.userAgent,
    });
    finalUrl = res.url;
    status = res.status;
    contentType = res.contentType;
    const isPdf = /application\/pdf/i.test(contentType) || startsWith(res.body, "%PDF-");
    const pdfDisabled = options.parsers !== undefined && !options.parsers.some((p) => (typeof p === "string" ? p : p.type) === "pdf");
    if (isPdf) {
      if (pdfDisabled) throw new AppError(415, "UNSUPPORTED_FILE", "PDF parsing is disabled by the parsers option");
      const pdf = await pdfToMarkdown(res.body);
      plainMarkdown = pdf.markdown;
      pdfMeta = { title: pdf.title, numPages: pdf.numPages };
      contentType ||= "application/pdf";
    } else if (!contentType || /html|xml/i.test(contentType)) {
      rawHtml = decodeBody(res.body, contentType);
      extracted = await extractFromHtml(rawHtml, { ...extractOpts, url: finalUrl });
    } else if (/^(text\/|application\/(json|javascript|x-ndjson))/i.test(contentType)) {
      const text = decodeBody(res.body, contentType);
      plainMarkdown = /json/i.test(contentType) ? `\`\`\`json\n${text}\n\`\`\`` : text;
      rawHtml = text;
    } else {
      throw new AppError(415, "UNSUPPORTED_FILE", `Unsupported content type: ${contentType}`);
    }
  }

  let markdown = plainMarkdown ?? extracted?.markdown ?? "";
  const title = String(extracted?.metadata.title ?? "") || extracted?.defuddle.title || pdfMeta?.title || "";
  if (extracted && onlyMainContent && !options.includeTags?.length) {
    const heading = extracted.defuddle.title || title;
    if (heading && !/^#\s/.test(markdown.trimStart())) markdown = `# ${heading}\n\n${markdown}`;
  }

  const metadata: Record<string, unknown> = { ...(extracted?.metadata ?? {}) };
  // Repeated <meta> tags can yield arrays (page-script `add`); the schema types these keys as strings.
  for (const k of ["title", "description", "language", "error"]) {
    const v = metadata[k];
    if (!Array.isArray(v)) continue;
    const first = v.find((x): x is string => typeof x === "string" && x.length > 0);
    if (first === undefined) delete metadata[k];
    else metadata[k] = first;
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
    sourceURL: url,
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

  if (needsLlm(formats)) {
    const content = `${title ? `# ${title}\n\n` : ""}${markdown}`;
    const sig = internal.signal;
    const [json, summary, answer, highlights] = await Promise.all([
      formats.json ? engine.llm.extractJson(content, formats.json, sig) : undefined,
      formats.summary ? engine.llm.summarize(content, sig) : undefined,
      formats.question ? engine.llm.answer(content, formats.question, sig) : undefined,
      formats.highlights ? engine.llm.highlights(content, formats.highlights, sig) : undefined,
    ]);
    if (formats.json) doc.json = json;
    if (summary !== undefined) doc.summary = summary;
    if (answer !== undefined) doc.answer = answer;
    if (highlights !== undefined) doc.highlights = highlights;
  }
  if (warnings.length) doc.warning = warnings.join("; ");

  return { document: doc, links: extracted?.links, linkTitles: extracted?.linkTitles };
}

function startsWith(body: Uint8Array, prefix: string): boolean {
  if (body.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (body[i] !== prefix.charCodeAt(i)) return false;
  return true;
}
