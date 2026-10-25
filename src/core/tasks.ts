import { log } from "../log.ts";
import { handleBatchPage } from "./batch.ts";
import { handleCrawlPage, handleCrawlStart } from "./crawl.ts";
import type { Engine } from "./engine.ts";
import { handleExtract } from "./extract.ts";
import { settleTask, type Task } from "./jobs/index.ts";

/**
 * Worker entry point: runs one queued task against the shared job store. Crawl-start and page tasks settle
 * their job's `pending` count exactly once, in the finally, even if dispatch throws or the job is no longer scraping.
 */
export async function runTask(engine: Engine, task: Task): Promise<void> {
  const { store } = engine.jobs;
  log.debug("task", { type: task.type, job: task.jobId, ...("url" in task ? { url: task.url } : {}) });
  if (task.type === "extract") {
    const job = await store.get(task.jobId);
    if (job?.status === "scraping") await handleExtract(engine, job);
    return;
  }
  let countCompleted = false;
  try {
    if (task.type === "crawl-start") return await handleCrawlStart(engine, task.jobId);
    const job = await store.get(task.jobId);
    // Cancelled or failed jobs still drain their queued pages.
    if (job?.status !== "scraping") return;
    if (job.kind === "crawl") return await handleCrawlPage(engine, job, task.url, task.depth);
    countCompleted = true;
    return await handleBatchPage(engine, job, task.url, task.options);
  } finally {
    await settleTask(engine, task.jobId, task.taskId, countCompleted);
  }
}
