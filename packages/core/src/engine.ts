import { ExtractPool } from "@searxng-js/sex-page";
import { SearxngService } from "@searxng-js/sex-searxng";
import pLimit from "p-limit";
import type { ChangeTracker, ScrapeBrowser, ScrapeCache, ScrapeDocs, ScrapeLlm } from "./capabilities.ts";
import type { CoreConfig } from "./config.ts";
import { log } from "./log.ts";
import type { Document, ScrapeRequest, SearchData, SearchRequest } from "./schemas.ts";
import { type MissingHints, scrapeUrl } from "./scrape.ts";
import { type SearchContext, search } from "./search.ts";

/**
 * Search and fetch, shared by every front-end (HTTP, MCP, CLI). sex-lite uses it as is; sex extends it with a browser,
 * an LLM, document conversion and jobs.
 */
export class BaseEngine<C extends CoreConfig = CoreConfig> implements SearchContext {
  /** The external SearXNG, or the one run as a child process. */
  readonly searxng: SearxngService;
  readonly scrapeLimit: ReturnType<typeof pLimit>;
  /** Caps the per-domain SearXNG queries of includeDomains across all concurrent searches, so they cannot get the upstream engines banned. */
  readonly searchDomainLimit = pLimit(4);
  /** HTML and PDF parsing, off the main thread. */
  readonly extractPool: ExtractPool;
  readonly browser?: ScrapeBrowser;
  readonly llm?: ScrapeLlm;
  readonly docs?: ScrapeDocs;
  readonly cache?: ScrapeCache;
  readonly changeTracker?: ChangeTracker;
  readonly missingHints?: MissingHints;

  constructor(
    readonly config: C,
    opts: { missingHints?: MissingHints } = {},
  ) {
    this.missingHints = opts.missingHints;
    this.searxng = new SearxngService({
      url: config.searxngUrl,
      binaryPath: config.searxngPath,
      settingsPath: config.searxngSettings,
      proxyUrl: config.proxyUrl,
      logger: log,
    });
    this.scrapeLimit = pLimit(config.concurrency);
    this.extractPool = new ExtractPool({ size: config.extractWorkers, taskTimeoutMs: Math.max(10_000, config.timeout), logger: log });
  }

  async scrape(req: ScrapeRequest, signal?: AbortSignal): Promise<Document> {
    const { url, ...options } = req;
    return (await scrapeUrl(this, url, options, { signal })).document;
  }

  search(req: SearchRequest, signal?: AbortSignal): Promise<{ data: SearchData; warning?: string }> {
    return search(this, req, signal);
  }

  /** Starts what takes a while to come up (SearXNG), so the first request does not wait for it. */
  async warmup(): Promise<void> {
    await this.searxng.warmup();
  }

  /** One-line description of optional capabilities, for startup logs and /health. */
  describe(): Record<string, string> {
    return { searxng: this.searxng.describe() };
  }

  async close(): Promise<void> {
    await this.extractPool.close();
    await this.searxng.close();
  }
}
