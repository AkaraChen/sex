import { join } from "node:path";
import { AppError, notFound } from "@searxng-js/sex-errors";
import { BaseEngine } from "@searxng-js/sex-server/engine";
import type { Config } from "../config.ts";
import type { BatchScrapeRequest, CrawlRequest, ExtractRequest, MapRequest, MapResult } from "../schemas.ts";
import { startBatchScrape } from "./batch.ts";
import { BrowserPool } from "./browser.ts";
import { SqliteScrapeCache } from "./cache.ts";
import { SqliteChangeTracker } from "./change-tracker.ts";
import { crawlParamsFromPrompt, startCrawl } from "./crawl.ts";
import { DocsConverter } from "./docs.ts";
import { startExtract } from "./extract.ts";
import { documentsLocation } from "./jobs/documents.ts";
import { createJobBackend, type JobBackend, type JobKind, type JobRecord } from "./jobs/index.ts";
import { Llm } from "./llm.ts";
import { mapSite } from "./map.ts";
import { abandonTask, runTask } from "./tasks.ts";

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

  constructor(config: Config) {
    super(config);
    if (config.dataDir) {
      this.cache = new SqliteScrapeCache(join(config.dataDir, "cache.sqlite"), {
        defaultMaxAge: config.cacheMaxAgeMs,
        ttlMs: config.cacheTtlMs,
        maxBytes: config.cacheMaxBytes,
      });
      this.changeTracker = new SqliteChangeTracker(join(config.dataDir, "change-tracking.sqlite"));
    }
    this.browser = new BrowserPool(config);
    this.llm = new Llm(config);
    this.docs = new DocsConverter(config);
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
