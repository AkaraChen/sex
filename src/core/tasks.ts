import { log } from "../log.ts";
import { handleBatchPage } from "./batch.ts";
import { handleCrawlPage, handleCrawlStart } from "./crawl.ts";
import type { Engine } from "./engine.ts";
import { handleExtract } from "./extract.ts";
import { settleTask, type Task } from "./jobs/index.ts";

/** Worker entry point: runs one queued task against the shared job store. */
export async function runTask(engine: Engine, task: Task): Promise<void> {
  const { store } = engine.jobs;
  log.debug("task", { type: task.type, job: task.jobId, ...("url" in task ? { url: task.url } : {}) });
  if (task.type === "crawl-start") return handleCrawlStart(engine, task.jobId);
  const job = await store.get(task.jobId);
  if (!job) return;
  if (task.type === "extract") {
    if (job.status === "scraping") await handleExtract(engine, job);
    return;
  }
  // Cancelled or failed jobs still drain their queued pages.
  if (job.status !== "scraping") return settleTask(store, job.id);
  if (job.kind === "crawl") return handleCrawlPage(engine, job, task.url, task.depth);
  return handleBatchPage(engine, job, task.url);
}
