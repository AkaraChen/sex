import { assertPublicUrl, parseHttpUrl } from "@searxng-js/sex-egress";
import type { JobsContext } from "./context.ts";
import { JobScheduler } from "./scheduler.ts";
import type { WebhookConfig } from "./schemas.ts";
import type { JobStore, TaskQueue } from "./types.ts";
import { sendWebhook } from "./webhook.ts";

export interface JobBackend {
  store: JobStore;
  queue: TaskQueue;
  /** Every task goes into the queue through this (order, pace), never directly. */
  scheduler: JobScheduler;
  close(): Promise<void>;
}

/** A job store and a task queue, composed by the app. `close()` closes the queue and then the store. */
export function createJobBackend(parts: { store: JobStore; queue: TaskQueue }): JobBackend {
  const { store, queue } = parts;
  return {
    store,
    queue,
    scheduler: new JobScheduler(queue),
    async close() {
      await queue.close();
      await store.close();
    },
  };
}

export async function validateWebhook(ctx: JobsContext, webhook: WebhookConfig | undefined): Promise<void> {
  if (!webhook) return;
  const url = parseHttpUrl(typeof webhook === "string" ? webhook : webhook.url);
  await assertPublicUrl(url, ctx.settings.allowPrivateNetwork);
}

/**
 * Marks one task of a job done; whoever finishes the last task completes the job. Each taskId settles at most once,
 * so a redelivered task cannot complete the job early or be counted twice. (`completed` is not counted here: a page
 * is counted when its document is stored, see `TaskEffects.page`.)
 */
export async function settleTask(ctx: JobsContext, jobId: string, taskId?: string): Promise<void> {
  const left = await ctx.jobs.store.settle(jobId, taskId);
  if (left === null || left > 0) return;
  await ctx.jobs.scheduler.release(jobId);
  if (await ctx.jobs.store.finish(jobId, "completed")) {
    const job = await ctx.jobs.store.get(jobId);
    if (job) await sendWebhook(ctx, job, "completed");
  }
}

export const PAGE_BUDGET_CHARS = 10 * 1024 * 1024;
