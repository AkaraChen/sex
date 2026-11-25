import { type CallTime, LocalService } from "@searxng-js/sex-local";
import { type SearchData, type SearchRequest, Searxng, searchWeb } from "@searxng-js/sex-search";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";

/** Formats and options firecrawl-local has no equivalent for; they are refused with a warning, never silently dropped. */
const LOCAL_FORMATS = new Set(["markdown", "html", "rawHtml", "links"]);
const IGNORED = [
  "actions",
  "blockAds",
  "fastMode",
  "json",
  "summary",
  "changeTracking",
  "parsers",
  "maxAge",
  "storeInCache",
  "proxy",
  "redactPII",
  "zeroDataRetention",
  "onlyCleanContent",
  "lockdown",
  "minAge",
];

export interface ScrapeRequest {
  url: string;
  formats?: unknown[];
  timeout?: number;
  [key: string]: unknown;
}

export interface ScrapeResult {
  success: true;
  data: Record<string, unknown>;
}

/** What a scrape and a search run on: the firecrawl-local instance, SearXNG, and the configuration they were built from. */
export class Engine {
  readonly local: LocalService;
  readonly searxng: Searxng;

  constructor(
    readonly config: Config,
    private readonly log: Logger,
  ) {
    this.local = new LocalService({
      url: config.localUrl,
      token: config.localToken,
      binaryPath: config.localPath,
      chromePath: config.chromePath,
      browser: config.browser,
      allowPrivate: config.allowPrivate,
      timeoutMs: config.timeoutMs,
      onOutput: (line) => log.debug("firecrawl-local", { output: line }),
    });
    this.searxng = new Searxng({
      url: config.searxngUrl,
      binaryPath: config.searxngPath,
      onOutput: (line) => log.debug("searxng", { output: line }),
    });
  }

  /** Scrapes through firecrawl-local and answers the Firecrawl v2 scrape shape. */
  async scrape(request: ScrapeRequest, signal?: AbortSignal): Promise<ScrapeResult> {
    const warnings: string[] = [];
    const body: Record<string, unknown> = { ...request };

    for (const key of IGNORED) {
      if (!(key in body)) continue;
      delete body[key];
      warnings.push(`\`${key}\` is not supported and was ignored`);
    }

    if (Array.isArray(body.formats)) {
      const names = body.formats.map(formatName);
      const kept = names.filter((name): name is string => !!name && LOCAL_FORMATS.has(name));
      const dropped = names.filter((name) => !!name && !LOCAL_FORMATS.has(name));
      if (dropped.length) warnings.push(`unsupported format(s): ${dropped.join(", ")}`);
      body.formats = kept.length ? kept : ["markdown"];
    }

    const time: CallTime = { signal };
    if (typeof body.timeout === "number" && body.timeout > 0) time.deadlineAt = Date.now() + body.timeout;

    const client = await this.local.client();
    const response = await client.scrape(body, time);
    const data = response.data ?? {};
    if (warnings.length) {
      data.warning = [data.warning, warnings.join("; ")]
        .filter((value) => typeof value === "string" && value)
        .join(" ");
    }
    return { success: true, data };
  }

  /** Searches SearXNG and answers the Firecrawl v2 search shape. */
  async search(request: SearchRequest, signal?: AbortSignal): Promise<{ data: SearchData; warning?: string }> {
    const client = await this.searxng.client();
    const time: CallTime = { signal };
    if (request.timeout) time.deadlineAt = Date.now() + request.timeout;
    const { data, warnings } = await searchWeb(client, request, time);
    return { data, warning: warnings.length ? warnings.join("; ") : undefined };
  }

  async map(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).map(body, { signal });
  }

  async crawl(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).crawl(body, { signal });
  }

  async crawlStatus(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).crawlStatus(id, { signal });
  }

  async crawlCancel(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).crawlCancel(id, { signal });
  }

  async batch(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).batch(body, { signal });
  }

  async batchStatus(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).batchStatus(id, { signal });
  }

  async batchCancel(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).batchCancel(id, { signal });
  }

  async parse(file: Blob, options?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).parse(file, options, { signal });
  }

  /** Starts both child processes. Failures are logged, not fatal: the first request pays for them. */
  async warmup(): Promise<void> {
    const results = await Promise.allSettled([this.local.warmup(), this.searxng.warmup()]);
    for (const result of results) {
      if (result.status === "rejected") {
        this.log.warn("warmup failed", {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  describe(): { firecrawlLocal: string; searxng: string } {
    return { firecrawlLocal: this.local.describe(), searxng: this.searxng.describe() };
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.local.close(), this.searxng.close()]);
  }
}

function formatName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "type" in value) return String((value as { type: unknown }).type);
  return undefined;
}
