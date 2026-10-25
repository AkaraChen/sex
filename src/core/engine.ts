import pLimit from "p-limit";
import type { Config } from "../config.ts";
import { AppError, notFound } from "../errors.ts";
import type {
  BatchScrapeRequest,
  CrawlRequest,
  Document,
  ExtractRequest,
  MapLink,
  MapRequest,
  ScrapeRequest,
  SearchData,
  SearchRequest,
} from "../schemas.ts";
import { startBatchScrape } from "./batch.ts";
import { BrowserPool } from "./browser.ts";
import { crawlParamsFromPrompt, startCrawl } from "./crawl.ts";
import { startExtract } from "./extract.ts";
import { createJobBackend, type JobBackend, type JobKind, type JobRecord } from "./jobs/index.ts";
import { Llm } from "./llm.ts";
import { mapSite } from "./map.ts";
import { scrapeUrl } from "./scrape.ts";
import { search } from "./search.ts";
import { runTask } from "./tasks.ts";

/** Everything the HTTP, MCP and CLI front-ends share. */
export class Engine {
  readonly browser: BrowserPool;
  readonly llm: Llm;
  readonly scrapeLimit: ReturnType<typeof pLimit>;

  constructor(readonly config: Config) {
    this.browser = new BrowserPool(config);
    this.llm = new Llm(config);
    this.scrapeLimit = pLimit(config.concurrency);
  }

  private backend?: JobBackend;

  /** Job store + task queue, created on first use (one-shot CLI commands never touch Redis). */
  get jobs(): JobBackend {
    if (!this.backend) {
      this.backend = createJobBackend(this.config);
      // The in-memory queue only exists in this process, so it always needs a local worker.
      if (this.backend.kind === "memory") this.startWorker();
    }
    return this.backend;
  }

  /** Consume queued crawl/batch/extract tasks in this process. */
  startWorker(): void {
    this.jobs.queue.startWorker((task) => runTask(this, task));
  }

  async getJob(id: string, kind: JobKind): Promise<JobRecord> {
    const job = await this.jobs.store.get(id);
    if (!job || job.kind !== kind) throw notFound(`Job ${id} not found`);
    return job;
  }

  async cancelJob(job: JobRecord): Promise<void> {
    if (!(await this.jobs.store.finish(job.id, "cancelled"))) {
      throw new AppError(409, "JOB_FINISHED", `Job ${job.id} already finished`);
    }
  }

  async scrape(req: ScrapeRequest, signal?: AbortSignal): Promise<Document> {
    const { url, ...options } = req;
    return (await scrapeUrl(this, url, options, { signal })).document;
  }

  search(req: SearchRequest, signal?: AbortSignal): Promise<{ data: SearchData; warning?: string }> {
    return search(this, req, signal);
  }

  map(req: MapRequest, signal?: AbortSignal): Promise<MapLink[]> {
    return mapSite(this, req, signal);
  }

  crawl(req: CrawlRequest, defaults?: Partial<CrawlRequest>): Promise<JobRecord> {
    return startCrawl(this, req, defaults);
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

  /** One-line description of optional capabilities, for startup logs. */
  describe(): Record<string, string> {
    return {
      searxng: this.config.searxngUrl,
      browser: this.browser.enabled ? (this.config.cdpUrl ?? "lightpanda") : "off (Defuddle/linkedom)",
      llm: this.config.llm ? `${this.config.llm.model} @ ${this.config.llm.baseUrl}` : "off",
      jobs: this.config.redisUrl ? "redis (bullmq)" : "memory",
    };
  }

  async close(): Promise<void> {
    await this.backend?.close();
    await this.browser.close();
  }
}
