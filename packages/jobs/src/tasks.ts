import { settleTask } from "./backend.ts";
import { handleBatchPage } from "./batch.ts";
import type { JobsContext } from "./context.ts";
import { handleCrawlPage, handleCrawlStart } from "./crawl.ts";
import { taskEffects } from "./effects.ts";
import { handleExtract } from "./extract.ts";
import type { Task, TaskOutcome } from "./types.ts";
import { deliverWebhook, sendWebhook } from "./webhook.ts";

/**
 * Worker entry point: runs one queued task against the shared job store. Crawl-start and page tasks settle
 * their job's `pending` count exactly once, in the finally, even if dispatch throws or the job is no longer scraping.
 */
export async function runTask(ctx: JobsContext, task: Task): Promise<TaskOutcome> {
  const { store } = ctx.jobs;
  ctx.logger?.debug("task", { type: task.type, job: task.jobId, ...("url" in task ? { url: task.url } : {}) });
  if (task.type === "webhook") {
    // Not settled: webhooks are not part of the job's `pending`.
    await deliverWebhook(ctx, task);
    return "done";
  }
  if (task.type === "extract") {
    const job = await store.get(task.jobId);
    if (job?.status !== "scraping") return "skipped";
    await handleExtract(ctx, job, task.taskId);
    return "done";
  }
  try {
    if (task.type === "crawl-start") {
      await handleCrawlStart(ctx, task.jobId, task.taskId);
      return "done";
    }
    const job = await store.get(task.jobId);
    // Cancelled or failed jobs still drain their queued pages, which costs their lane no cooldown.
    if (job?.status !== "scraping") return "skipped";
    if (job.kind === "crawl") await handleCrawlPage(ctx, job, task.url, task.depth, task.taskId);
    else await handleBatchPage(ctx, job, task.url, task.options, task.taskId);
    return "done";
  } finally {
    await settleTask(ctx, task.jobId, task.taskId);
  }
}

/** What an interrupted task is recorded as when the queue gives up on it. */
const ABANDONED = "The task was interrupted too many times (the process stopped while it ran) and was given up on";

/**
 * Ends a task the queue dead-lettered (see `TaskQueue.startWorker`): no handler will run it again, so it must do here
 * what its handler and `runTask` do on the way out, or its job would stay "scraping" with `pending` above zero. A page
 * is recorded as failed (through `taskEffects`, so it also sends the `page` webhook with `success: false`), a crawl
 * start or an extract fails its job, and the task is settled. All of it is claimed per taskId, so an abandoned task
 * that was handled before a crash is not handled twice.
 */
export async function abandonTask(ctx: JobsContext, task: Task): Promise<void> {
  const { store } = ctx.jobs;
  const job = await store.get(task.jobId);
  switch (task.type) {
    case "webhook":
      return; // The delivery is lost; nothing waits for it.
    case "extract":
      if (job && (await store.finish(job.id, "failed", { error: ABANDONED }))) await sendWebhook(ctx, job, "failed", [], ABANDONED);
      return;
    case "crawl-start":
      if (job && (await store.finish(job.id, "failed", { error: ABANDONED }))) await sendWebhook(ctx, job, "failed", [], ABANDONED);
      break;
    case "page":
      if (job?.status === "scraping") await taskEffects(ctx, job, task.taskId).failure(task.url, ABANDONED, "INTERNAL_ERROR");
      break;
  }
  await settleTask(ctx, task.jobId, task.taskId);
}

/**
 * Starts consuming the context's task queue in this process: each task runs through `runTask`, and a task the queue gave up on
 * (see `TaskQueue.startWorker`) through `abandonTask`.
 */
export function startWorker(ctx: JobsContext): void {
  ctx.jobs.queue.startWorker(
    (task) => runTask(ctx, task),
    (task) => abandonTask(ctx, task),
  );
}
