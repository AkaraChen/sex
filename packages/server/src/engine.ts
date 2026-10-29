import { ExtractPool } from "@searxng-js/sex-page";
import {
  type ChangeTracker,
  type Document,
  type MissingHints,
  type ScrapeBrowser,
  type ScrapeCache,
  type ScrapeDocs,
  type ScrapeLlm,
  type ScrapeRequest,
  type ScrapeSettings,
  scrapeUrl,
} from "@searxng-js/sex-scrape";
import { type SearchContext, type SearchData, type SearchRequest, search } from "@searxng-js/sex-search";
import { SearxngService } from "@searxng-js/sex-searxng";
import pLimit from "p-limit";
import type { CoreConfig } from "./config.ts";
import { log } from "./log.ts";

/**
 * Search and fetch, shared by every front-end (HTTP, MCP, CLI). sex-lite uses it as is; sex extends it with a browser,
 * an LLM, document conversion and jobs.
 */
export class BaseEngine<C extends CoreConfig = CoreConfig> implements SearchContext {
  /** The external SearXNG, or the one run as a child process. */
  readonly searxng: SearxngService;
  /** What the scrape and search packages read of the config. */
  readonly settings: ScrapeSettings;
  /** The stderr logger, handed to the packages (they are silent without one). */
  readonly logger = log;
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
    this.settings = {
      allowPrivateNetwork: config.allowPrivateNetwork,
      proxyUrl: config.proxyUrl,
      stealthProxyUrl: config.stealthProxyUrl,
      userAgent: config.userAgent,
      timeout: config.timeout,
      maxBodyBytes: config.maxBodyBytes,
    };
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
