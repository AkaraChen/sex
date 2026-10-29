import { subscribe } from "node:diagnostics_channel";
import { join } from "node:path";
import {
  createDocumentLog,
  createJobBackend,
  MemoryTaskQueue,
  SqliteJobStore,
  startBatchScrape,
  startCrawl,
  startWorker,
} from "@searxng-js/sex-jobs";
import { cfg, makeCtx, report } from "./common.mjs";

const seen = [];
subscribe("searxng-js:sex:jobs", (m) => seen.push(m));

const store = new SqliteJobStore(join(cfg.dir, "jobs.sqlite"), 24 * 3600_000, createDocumentLog({ dataDir: cfg.dir }));
const jobs = createJobBackend({ store, queue: new MemoryTaskQueue({ concurrency: 4 }) });
const { ctx, extractPool } = makeCtx({
  jobs,
  jobSettings: { concurrency: 4, extractWildcardPages: 10 },
  search: async () => ({ data: {} }),
});

async function finished(id) {
  const end = Date.now() + 60_000;
  for (;;) {
    const job = await jobs.store.get(id);
    if (job && job.status !== "scraping") return job;
    if (Date.now() > end) throw new Error(`job ${id} still ${job?.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const docs = async (id) => (await jobs.store.documents(id, 0, 10_000_000)).data;
const sources = (list) => list.map((d) => d.metadata?.sourceURL).sort();

try {
  startWorker(ctx);
  const batch = await startBatchScrape(ctx, { urls: [`${cfg.siteUrl}/docs/a`, `${cfg.siteUrl}/docs/b`] });
  const batchJob = await finished(batch.job.id);
  const batchDocs = await docs(batch.job.id);

  const crawl = await startCrawl(ctx, { url: `${cfg.siteUrl}/`, limit: 10, sitemap: "skip", crawlEntireDomain: true });
  const crawlJob = await finished(crawl.job.id);
  const crawlDocs = await docs(crawl.job.id);
  report({
    batch: {
      status: batchJob.status,
      total: batchJob.total,
      completed: batchJob.completed,
      docs: sources(batchDocs),
      markdown: batchDocs.map((d) => d.markdown).join("\n"),
    },
    crawl: { status: crawlJob.status, completed: crawlJob.completed, docs: sources(crawlDocs) },
    taskMessages: seen.filter((m) => m.msg === "task").length,
  });
} finally {
  await jobs.close();
  await extractPool.close();
}
