import { join } from "node:path";
import { BrowserPool, type BrowserPoolOptions } from "@searxng-js/sex-browser";
import { DocsConverter } from "@searxng-js/sex-docs";
import { AppError, notFound } from "@searxng-js/sex-errors";
import {
  abandonTask,
  type BatchScrapeRequest,
  type CrawlRequest,
  crawlParamsFromPrompt,
  documentsLocation,
  type ExtractRequest,
  type JobBackend,
  type JobKind,
  type JobRecord,
  type JobsSettings,
  runTask,
  startBatchScrape,
  startCrawl,
  startExtract,
} from "@searxng-js/sex-jobs";
import { Llm } from "@searxng-js/sex-llm";
import { type MapRequest, type MapResult, mapSite } from "@searxng-js/sex-map";
import { BaseEngine } from "@searxng-js/sex-server/engine";
import { SqliteChangeTracker, SqliteScrapeCache } from "@searxng-js/sex-store";
import type { Config } from "../config.ts";
import { createJobBackend } from "./jobs/index.ts";

/** The browser pool's options from the app's settings. */
export function browserOptions(config: Config): BrowserPoolOptions {
  return {
    concurrency: config.concurrency,
    allowPrivateNetwork: config.allowPrivateNetwork,
    proxyUrl: config.proxyUrl,
    lightpanda: config.lightpanda,
    lightpandaPath: config.lightpandaPath,
    cdpUrl: config.cdpUrl,
    blockMedia: config.blockMedia,
  };
}

/** Everything the HTTP, MCP and CLI front-ends share: the core search and fetch, plus browser, LLM, documents and jobs. */
export class Engine extends BaseEngine<Config> {
  override readonly browser: BrowserPool;
  override readonly llm: Llm;
  /** PDFs, office documents and images via here-docs, when SEX_DOCS is on. */
  override readonly docs: DocsConverter;
  /** Fetched pages for `maxAge`, in `<dataDir>/cache.sqlite`; none without a data dir (one-shot CLI, tests). */
  declare readonly cache?: SqliteScrapeCache;
  /** The previous scrape of each (URL, tag) for `changeTracking`, in `<dataDir>/change-tracking.sqlite`; none without a data dir. */
  declare readonly changeTracker?: SqliteChangeTracker;

  /** What the jobs read of the config (how pages are fetched is `settings`). */
  readonly jobSettings: JobsSettings;

  constructor(config: Config) {
    super(config);
    this.jobSettings = {
      concurrency: config.concurrency,
      extractWildcardPages: config.extractWildcardPages,
      webhookSecret: config.webhookSecret,
    };
    if (config.dataDir) {
      this.cache = new SqliteScrapeCache(join(config.dataDir, "cache.sqlite"), {
        defaultMaxAge: config.cacheMaxAgeMs,
        ttlMs: config.cacheTtlMs,
        maxBytes: config.cacheMaxBytes,
      });
      this.changeTracker = new SqliteChangeTracker(join(config.dataDir, "change-tracking.sqlite"));
    }
    // The plugins take their own options; this is where the app's settings become them.
    this.browser = new BrowserPool(browserOptions(config));
    this.llm = new Llm({ endpoint: config.llm, maxInputChars: config.llmMaxInputChars, timeoutMs: config.llmTimeout });
    this.docs = new DocsConverter({ enabled: config.docs, concurrency: config.docsConcurrency });
  }

  private backend?: JobBackend;

  /** Job store + task queue, created on first use (one-shot CLI commands never open the database). Tasks run in this process. */
  get jobs(): JobBackend {
    if (!this.backend) {
      this.backend = createJobBackend(this.config);
      this.backend.queue.startWorker(
        (task) => runTask(this, task),
        (task) => abandonTask(this, task),
      );
    }
    return this.backend;
  }

  async getJob(id: string, kind: JobKind): Promise<JobRecord> {
    const job = await this.jobs.store.get(id);
    if (!job || job.kind !== kind) throw notFound(`Job ${id} not found`);
    return job;
  }

  async cancelJob(job: JobRecord): Promise<void> {
    if (!(await this.jobs.store.finish(job.id, "cancelled"))) {
      throw new AppError("JOB_FINISHED", `Job ${job.id} already finished`);
    }
  }

  map(req: MapRequest, signal?: AbortSignal): Promise<MapResult> {
    return mapSite(this, req, signal);
  }

  /** Starts a crawl; also reports the options a `prompt` was turned into. */
  startCrawl(req: CrawlRequest, defaults?: Partial<CrawlRequest>) {
    return startCrawl(this, req, defaults);
  }

  async crawl(req: CrawlRequest, defaults?: Partial<CrawlRequest>): Promise<JobRecord> {
    return (await this.startCrawl(req, defaults)).job;
  }

  crawlParamsPreview(url: string, prompt: string): Promise<Record<string, unknown>> {
    return crawlParamsFromPrompt(this, url, prompt);
  }

  batchScrape(req: BatchScrapeRequest) {
    return startBatchScrape(this, req);
  }

  extract(req: ExtractRequest) {
    return startExtract(this, req);
  }

  override async warmup(): Promise<void> {
    await super.warmup();
    await this.browser.warmup();
    await this.docs.warmup();
  }

  override describe(): Record<string, string> {
    return {
      ...super.describe(),
      browser: this.browser.enabled ? (this.config.cdpUrl ?? "lightpanda") : "off (Defuddle/linkedom)",
      llm: this.config.llm
        ? `${this.config.llm.model}${this.config.llm.smallModel ? ` (small: ${this.config.llm.smallModel})` : ""} @ ${this.config.llm.baseUrl}`
        : "off",
      docs: this.docs.enabled ? "here-docs (structured PDF/office, OCR)" : "off (unpdf text only)",
      jobs: this.config.dataDir ? `sqlite (${this.config.dataDir})` : "memory",
      documents: documentsLocation(this.config),
      cache: this.cache
        ? `sqlite (${this.config.dataDir}/cache.sqlite, default maxAge ${this.config.cacheMaxAgeMs} ms)`
        : "off (no data dir)",
      changeTracking: this.changeTracker ? `sqlite (${this.config.dataDir}/change-tracking.sqlite)` : "off (no data dir)",
    };
  }

  override async close(): Promise<void> {
    await this.backend?.close();
    await this.browser.close();
    await this.docs.close();
    this.cache?.close();
    this.changeTracker?.close();
    await super.close();
  }
}
